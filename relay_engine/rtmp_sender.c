#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/time.h>

#define IO_TIMEOUT_US (15LL * AV_TIME_BASE)
#define SECRET_CAPACITY 8192

static volatile sig_atomic_t stopped;
static int64_t deadline;

static void stop_sender(int signum) { (void)signum; stopped = 1; }
static int interrupted(void *opaque) {
    (void)opaque;
    return stopped || (deadline && av_gettime_relative() >= deadline);
}
static void bound_io(void) { deadline = av_gettime_relative() + IO_TIMEOUT_US; }
static void wipe(void *memory, size_t length) {
    volatile unsigned char *bytes = memory;
    while (length--) *bytes++ = 0;
}

static int read_destination(char *secret) {
    size_t used = 0;
    bound_io();
    while (!interrupted(NULL)) {
        struct pollfd input = { STDIN_FILENO, POLLIN, 0 };
        int ready = poll(&input, 1, 100);
        if (ready < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (!ready) continue;
        ssize_t count = read(STDIN_FILENO, secret + used, SECRET_CAPACITY - 1 - used);
        if (count < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (!count) {
            secret[used] = '\0';
            return used && (!strncmp(secret, "rtmp://", 7) || !strncmp(secret, "rtmps://", 8))
                && !memchr(secret, '\n', used) && !memchr(secret, '\r', used)
                && !memchr(secret, '\0', used) ? 0 : -1;
        }
        used += (size_t)count;
        if (used == SECRET_CAPACITY - 1) return -1;
    }
    return -1;
}

int main(int argc, char **argv) {
    AVFormatContext *input = NULL, *output = NULL;
    AVPacket *packet = NULL;
    char secret[SECRET_CAPACITY] = {0};
    int selected[2] = {-1, -1};
    int status = 1, header_written = 0;
    const char *failure = "initialization failed";
    int64_t origin = AV_NOPTS_VALUE, wall_start = 0, media_start = AV_NOPTS_VALUE;
    av_log_set_level(AV_LOG_QUIET);
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = stop_sender;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    if (argc != 2) { failure = "expected local HLS playlist path"; goto done; }
    if (read_destination(secret) < 0) { failure = "invalid destination pipe"; goto done; }
    close(STDIN_FILENO);
    if (avformat_network_init() < 0) goto done;
    input = avformat_alloc_context();
    if (!input) goto done;
    input->interrupt_callback = (AVIOInterruptCB){interrupted, NULL};
    bound_io();
    failure = "cannot open local HLS input";
    if (avformat_open_input(&input, argv[1], NULL, NULL) < 0) goto done;
    bound_io();
    if (avformat_find_stream_info(input, NULL) < 0) goto done;
    failure = "input requires H.264 video and AAC when audio is present";
    selected[0] = av_find_best_stream(input, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    selected[1] = av_find_best_stream(input, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (selected[0] < 0 ||
        input->streams[selected[0]]->codecpar->codec_id != AV_CODEC_ID_H264 ||
        (selected[1] >= 0 && input->streams[selected[1]]->codecpar->codec_id != AV_CODEC_ID_AAC))
        goto done;
    failure = "cannot configure FLV output";
    if (avformat_alloc_output_context2(&output, NULL, "flv", secret) < 0 || !output) goto done;
    output->interrupt_callback = (AVIOInterruptCB){interrupted, NULL};
    for (int index = 0; index < 2; ++index) {
        if (selected[index] < 0) continue;
        AVStream *source = input->streams[selected[index]];
        AVStream *target = avformat_new_stream(output, NULL);
        if (!target || avcodec_parameters_copy(target->codecpar, source->codecpar) < 0) goto done;
        target->codecpar->codec_tag = 0;
        target->time_base = source->time_base;
        if (source->start_time != AV_NOPTS_VALUE) {
            int64_t start = av_rescale_q(source->start_time, source->time_base, AV_TIME_BASE_Q);
            if (origin == AV_NOPTS_VALUE || start < origin) origin = start;
        }
    }
    if (input->start_time != AV_NOPTS_VALUE) origin = input->start_time;
    failure = "cannot connect publishing output";
    bound_io();
    if (avio_open2(&output->pb, secret, AVIO_FLAG_WRITE, &output->interrupt_callback, NULL) < 0) goto done;
    wipe(secret, sizeof(secret));
    bound_io();
    if (avformat_write_header(output, NULL) < 0) goto done;
    header_written = 1;
    packet = av_packet_alloc();
    if (!packet) goto done;
    failure = "media read or publishing write failed";
    while (!stopped) {
        bound_io();
        int result = av_read_frame(input, packet);
        if (result == AVERROR_EOF) { status = 0; break; }
        if (result < 0) goto done;
        int target_index = packet->stream_index == selected[0] ? 0 :
                           packet->stream_index == selected[1] ? 1 : -1;
        if (target_index < 0) { av_packet_unref(packet); continue; }
        AVStream *source = input->streams[packet->stream_index];
        AVStream *target = output->streams[target_index];
        int64_t timestamp = packet->dts != AV_NOPTS_VALUE ? packet->dts : packet->pts;
        if (origin == AV_NOPTS_VALUE && timestamp != AV_NOPTS_VALUE)
            origin = av_rescale_q(timestamp, source->time_base, AV_TIME_BASE_Q);
        if (timestamp != AV_NOPTS_VALUE) {
            int64_t media_time = av_rescale_q(timestamp, source->time_base, AV_TIME_BASE_Q);
            if (media_start == AV_NOPTS_VALUE) { media_start = media_time; wall_start = av_gettime_relative(); }
            int64_t due = wall_start + media_time - media_start;
            deadline = 0;
            while (!stopped && av_gettime_relative() < due) {
                int64_t remaining = due - av_gettime_relative();
                if (remaining > 0) av_usleep((unsigned)(remaining > 50000 ? 50000 : remaining));
            }
        }
        if (stopped) break;
        if (origin != AV_NOPTS_VALUE) {
            int64_t offset = av_rescale_q(origin, AV_TIME_BASE_Q, source->time_base);
            if (packet->pts != AV_NOPTS_VALUE) packet->pts -= offset;
            if (packet->dts != AV_NOPTS_VALUE) packet->dts -= offset;
        }
        av_packet_rescale_ts(packet, source->time_base, target->time_base);
        packet->stream_index = target_index;
        packet->pos = -1;
        bound_io();
        if (av_interleaved_write_frame(output, packet) < 0) goto done;
        av_packet_unref(packet);
    }
    if (stopped) status = 0;
    if (header_written) {
        bound_io();
        if (av_write_trailer(output) < 0 && !stopped) status = 1;
    }
done:
    wipe(secret, sizeof(secret));
    av_packet_free(&packet);
    if (output) {
        bound_io();
        if (output->pb && avio_closep(&output->pb) < 0 && !stopped) status = 1;
        if (output->url) wipe(output->url, strlen(output->url));
        avformat_free_context(output);
    }
    avformat_close_input(&input);
    avformat_network_deinit();
    if (status && !stopped) fprintf(stderr, "RTMP sender: %s\n", failure);
    return stopped ? 0 : status;
}
