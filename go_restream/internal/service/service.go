package service

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gotd/log/logzap"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	updhook "github.com/gotd/td/telegram/updates/hook"
	"github.com/gotd/td/tg"
	"go.uber.org/zap"

	"github.com/aleskxyz/tgtv/internal/api"
	"github.com/aleskxyz/tgtv/internal/auth"
	"github.com/aleskxyz/tgtv/internal/config"
	"github.com/aleskxyz/tgtv/internal/discovery"
	"github.com/aleskxyz/tgtv/internal/ingest"
	"github.com/aleskxyz/tgtv/internal/restream"
	"github.com/aleskxyz/tgtv/internal/stream"
	"github.com/aleskxyz/tgtv/internal/thumbnails"
	"github.com/aleskxyz/tgtv/internal/viewer"
	"golang.org/x/sys/unix"
	"path/filepath"
)

func Run(ctx context.Context, cfg config.Settings, pathSecret string, log *zap.Logger) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	releaseLease, err := restream.AcquireHostedLease(ctx, cancel)
	if err != nil {
		return err
	}
	defer releaseLease()
	lock, err := os.OpenFile(cfg.SessionPath()+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fmt.Errorf("session is already in use on this host")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	if len(os.Getenv("ADMIN_TOKEN")) < 32 {
		return fmt.Errorf("ADMIN_TOKEN must contain at least 32 characters")
	}
	// Every internal HLS URL remains on loopback, including nested playlists.
	cfg.PublicBaseURL = fmt.Sprintf("http://127.0.0.1:%d", cfg.HTTPPort+1)
	if !config.SessionExists(cfg) {
		return fmt.Errorf("no Telegram session — run: tgtv login")
	}
	log.Info("starting", zap.String("log_level", cfg.LogLevel))

	registry := discovery.NewRegistry()
	dispatcher := tg.NewUpdateDispatcher()
	gaps := updates.New(updates.Config{
		Handler: &dispatcher,
		Logger:  logzap.New(log.Named("gaps")),
	})

	client := auth.NewClient(cfg, log, telegram.Options{
		UpdateHandler: gaps,
		Middlewares: []telegram.Middleware{
			updhook.UpdateHook(gaps.Handle),
		},
	})

	return client.Run(ctx, func(ctx context.Context) error {
		status, err := client.Auth().Status(ctx)
		if err != nil {
			return err
		}
		if !status.Authorized {
			return fmt.Errorf("telegram session expired — run: tgtv login")
		}

		self, err := client.Self(ctx)
		if err != nil {
			return err
		}
		apiClient := client.API()
		mt := stream.NewMTProto(apiClient, client)

		thumbs := thumbnails.NewStore(apiClient, cfg.ThumbnailsDir(), log)
		supervisor := ingest.NewSupervisor(mt, self, registry, thumbs, cfg, ctx, log)
		supervisor.StartStaleProcessCleanup(ctx)
		viewers := viewer.NewManager(cfg.IdleGraceSeconds, func(streamID string) {
			if supervisor.IsIngesting(streamID) {
				supervisor.StopIngest(streamID)
			}
		})
		scanner := discovery.NewScanner(apiClient, registry, cfg, self.ID, log)
		scanner.SetOnChannelSeen(thumbs.RememberChannel)
		scanner.SetOnLiveDiscovered(func(chatID int64) {
			thumbs.Prefetch(ctx, chatID)
		})
		scanner.SetOnLiveMetadataUpdated(func(chatID int64, chat tg.ChatClass) {
			photoChanged := thumbs.SyncPhotoFromChat(chat)
			if photoChanged {
				supervisor.RefreshLogoForChat(chatID)
			}
			if !photoChanged && !thumbs.ShouldPrefetch(chatID) {
				return
			}
			prefetchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			if _, err := thumbs.GetJPEG(prefetchCtx, chatID); err != nil {
				return
			}
			if photoChanged {
				supervisor.RefreshLogoForChat(chatID)
			}
		})
		scanner.SetOnLiveEnded(func(streamID string) {
			if supervisor.IsIngesting(streamID) {
				supervisor.StopIngest(streamID)
			}
		})
		scanner.SetOnCallSuperseded(func(streamID string) {
			supervisor.RestartIngest(streamID)
		})
		scanner.Register(&dispatcher)

		go func() {
			backoff := time.Second
			for {
				err := gaps.Run(ctx, apiClient, self.ID, updates.AuthOptions{
					OnStart: func(ctx context.Context) {
						log.Info("telegram updates connected")
					},
				})
				if ctx.Err() != nil {
					return
				}
				log.Error("updates manager stopped, restarting",
					zap.Error(err),
					zap.Duration("backoff", backoff),
				)
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
				}
				if backoff < 60*time.Second {
					backoff *= 2
				}
			}
		}()

		scanner.Start(ctx)
		viewers.Start(ctx)

		capture := &restream.Capture{API: apiClient, Registry: registry, Ingest: supervisor, Viewers: viewers, BaseURL: cfg.PublicBaseURL + "/p/" + pathSecret}
		relayCtx, stopRelay := context.WithCancel(ctx)
		defer stopRelay()
		destination, err := restream.NewTelegramDestination(filepath.Join(cfg.ConfigDir, "owned-call.json"), apiClient, registry)
		if err != nil {
			return err
		}
		sender := os.Getenv("RTMP_SENDER")
		if sender == "" {
			sender = "rtmp_sender"
		}
		media := restream.NewProcessMedia(relayCtx, filepath.Join(cfg.ConfigDir, "output"), sender)
		controller, err := restream.NewController(filepath.Join(cfg.ConfigDir, "controls.json"), capture, destination, media)
		if err != nil {
			return err
		}
		go capture.PollOfficialStreams(relayCtx)
		relayDone := make(chan struct{})
		go func() { defer close(relayDone); controller.Run(relayCtx) }()
		defer func() { stopRelay(); <-relayDone }()
		httpServer := api.NewServer(cfg, pathSecret, registry, thumbs, supervisor, viewers, log)
		dashboard, err := restream.NewDashboard(controller, os.Getenv("ADMIN_TOKEN"), media.Dir)
		if err != nil {
			return err
		}
		dashboard.SourceArchive = os.Getenv("SOURCE_ARCHIVE")
		testPreview := restream.NewRTMPTestPreview(relayCtx, filepath.Join(cfg.ConfigDir, "test-preview"), cfg.PublicBaseURL+"/test-preview/index.m3u8")
		dashboard.PreparePreview = testPreview.Prepare
		go testPreview.Run(relayCtx)
		srv := &http.Server{
			Addr:              fmt.Sprintf("%s:%d", cfg.HTTPHost, cfg.HTTPPort),
			Handler:           dashboard,
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
		}

		privateMux := http.NewServeMux()
		privateMux.Handle("/test-preview/", http.StripPrefix("/test-preview/", testPreview))
		privateMux.Handle("/", httpServer.Handler())
		captureServer := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", cfg.HTTPPort+1), Handler: privateMux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
		errCh := make(chan error, 2)
		go func() {
			if err := captureServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				errCh <- err
			}
		}()
		defer captureServer.Close()
		go func() {
			log.Info("HTTP listening",
				zap.String("addr", srv.Addr),
				zap.String("playlist", fmt.Sprintf("%s/p/<secret>/playlist.m3u", cfg.PublicBaseURL)),
			)
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				errCh <- err
			}
		}()

		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		defer signal.Stop(sigCh)

		select {
		case <-ctx.Done():
		case <-sigCh:
			log.Info("shutdown requested")
		case err := <-errCh:
			return err
		}

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		stopRelay()
		<-relayDone
		supervisor.PrepareShutdown()
		_ = srv.Shutdown(shutdownCtx)
		_ = captureServer.Shutdown(shutdownCtx)
		scanner.Stop()
		viewers.Stop()
		supervisor.StopAll()
		mt.Close()
		return nil
	})
}
