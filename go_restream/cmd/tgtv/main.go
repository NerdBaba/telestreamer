package main

import (
	"context"
	"fmt"
	"os"

	"go.uber.org/zap"

	"github.com/aleskxyz/tgtv/internal/auth"
	"github.com/aleskxyz/tgtv/internal/config"
	"github.com/aleskxyz/tgtv/internal/restream"
	"github.com/aleskxyz/tgtv/internal/service"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	if os.Args[1] == "import-session" {
		if len(os.Args) != 5 || os.Args[4] != "--previous-holder-stopped" {
			fmt.Fprintln(os.Stderr, "Usage: streamdesk import-session export.json destination.json --previous-holder-stopped")
			os.Exit(1)
		}
		if err := restream.ImportSession(os.Args[2], os.Args[3]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("Offline import complete; no Telegram connection opened.")
		return
	}
	if os.Args[1] == "demo" {
		if err := restream.RunDemo(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	log, err := config.NewLogger(cfg.LogLevel, cfg.LogFormat)
	if err != nil {
		fmt.Fprintf(os.Stderr, "logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() //nolint:errcheck

	switch os.Args[1] {
	case "login":
		if err := config.EnsureDirs(cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		phone := ""
		if len(os.Args) > 2 {
			phone = os.Args[2]
		}
		if err := auth.LoginInteractive(context.Background(), cfg, phone, log); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "logout":
		if err := auth.Logout(context.Background(), cfg, log); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("Logged out.")
	case "status":
		if err := auth.Status(context.Background(), cfg, log); err != nil {
			os.Exit(1)
		}
	case "serve":
		if err := config.EnsureDirs(cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := restream.RestoreHostedSession(cfg.SessionPath()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		secret, err := config.LoadOrCreatePathSecret(cfg)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		cdnSecret, err := config.LoadOrCreateMediamtxHLSCDNSecret(cfg)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		cfg.MediamtxHLSCDNSecret = cdnSecret
		if err := service.Run(context.Background(), cfg, secret, log); err != nil {
			log.Error("serve failed", zap.Error(err))
			os.Exit(1)
		}
	case "url":
		if err := config.EnsureDirs(cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		rotate := len(os.Args) > 2 && os.Args[2] == "rotate"
		var secret string
		var err error
		if rotate {
			secret, err = config.RotatePathSecret(cfg)
			if err == nil {
				fmt.Println("Path secret rotated.")
			}
		} else {
			secret, err = config.LoadOrCreatePathSecret(cfg)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("%s/p/%s/playlist.m3u\n", cfg.PublicBaseURL, secret)
	default:
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `Usage: tgtv <command>

Commands:
  demo           Local generated-video demo (no Telegram connection)
  login [phone]   Authenticate with Telegram
  logout          Remove saved session
  status          Check session
  serve           Run HTTP + discovery + ingest
  url             Print playlist URL
  url rotate      Rotate path secret
`)
}
