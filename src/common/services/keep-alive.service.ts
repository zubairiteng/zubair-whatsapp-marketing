import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createLogger } from './logger.service';

/**
 * Service to prevent Render free-tier spin-down (sleep mode) by sending an internal HTTPS
 * ping to its public domain every 8 minutes. Render counts external domain HTTPS requests
 * as real incoming web traffic, resetting the 15-minute inactivity shutdown timer.
 */
@Injectable()
export class KeepAliveService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private readonly logger = createLogger('KeepAliveService');

  onApplicationBootstrap(): void {
    const defaultUrl = 'https://zubair-whatsapp-marketing.onrender.com';
    const rawUrl = process.env.RENDER_EXTERNAL_URL || defaultUrl;
    const baseUrl = rawUrl.replace(/\/$/, '');
    const pingUrl = `${baseUrl}/api/health`;

    // Render free tier sleeps after 15 minutes of no incoming HTTP requests.
    // Pinging every 8 minutes keeps the service awake 24/7.
    const PING_INTERVAL_MS = 8 * 60 * 1000;

    this.timer = setInterval(async () => {
      try {
        const res = await fetch(pingUrl, {
          headers: { 'User-Agent': 'OpenWA-KeepAlive/1.0' },
        });
        if (res.ok) {
          this.logger.debug(`Keep-alive ping to ${pingUrl} OK (${res.status})`);
        } else {
          this.logger.warn(`Keep-alive ping to ${pingUrl} status ${res.status}`);
        }
      } catch (err) {
        this.logger.warn(`Keep-alive ping warning: ${String(err)}`);
      }
    }, PING_INTERVAL_MS);

    // Initial ping after 30 seconds
    setTimeout(async () => {
      try {
        await fetch(pingUrl, { headers: { 'User-Agent': 'OpenWA-KeepAlive/1.0' } });
        this.logger.log(`Keep-alive initial self-ping initialized for ${pingUrl}`);
      } catch (err) {
        this.logger.warn(`Keep-alive initial ping: ${String(err)}`);
      }
    }, 30000);
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
