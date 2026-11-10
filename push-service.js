const db = require('./db');
const https = require('https');

let webpush = null;
async function getWebPush() {
  if (!webpush) {
    const mod = await import('web-push');
    webpush = mod.default || mod;
  }
  return webpush;
}

class PushService {
  constructor() {
    this.initialized = false;
    this.publicKey = null;
    this.privateKey = null;
    this.initPromise = this.init();
  }

  async init() {
    try {
      const wp = await getWebPush();
      const settings = db.getSettings();
      if (settings.vapidKeys && settings.vapidKeys.publicKey && settings.vapidKeys.privateKey) {
        this.publicKey = settings.vapidKeys.publicKey;
        this.privateKey = settings.vapidKeys.privateKey;
      } else {
        const generated = wp.generateVAPIDKeys();
        this.publicKey = generated.publicKey;
        this.privateKey = generated.privateKey;
        await db.updateSettings({ vapidKeys: generated });
        await db.addLog('info', 'Generated new VAPID keys for Web Push');
      }

      wp.setVapidDetails(
        'mailto:levy.contact.app@gmail.com',
        this.publicKey,
        this.privateKey
      );
      this.initialized = true;
      console.log('✅ WebPush Service initialized with VAPID Public Key:', this.publicKey.substring(0, 16) + '...');
    } catch (err) {
      console.error('❌ Failed to initialize WebPush Service:', err);
      db.addLog('error', 'PushService init failure', err.message);
    }
  }

  async getPublicKey() {
    await this.initPromise;
    return this.publicKey;
  }

  /**
   * Broadcast an alert to all registered subscriptions for the boyfriend's iPhone/devices
   */
  async sendAlertNotification(alert) {
    const subscriptions = db.getSubscriptions();
    const results = {
      total: subscriptions.length,
      successCount: 0,
      failCount: 0,
      errors: []
    };

    if (subscriptions.length === 0) {
      db.addLog('warn', 'Niciun dispozitiv abonat la notificări push pentru alertă: ' + alert.title);
    }

    const payload = JSON.stringify({
      title: alert.title || '❤️ Pentru inima mea: Alerta!',
      body: alert.note 
        ? `${alert.message}\n💬 Notă: "${alert.note}"\n⏰ ${alert.timeOnly || ''}`
        : `${alert.message}\n⏰ Ora: ${alert.timeOnly || ''}`,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      image: '/icons/banner.png',
      tag: 'heart-alert-' + (alert.id || Date.now()),
      renotify: true,
      requireInteraction: true,
      silent: false,
      timestamp: Date.now(),
      vibrate: [400, 150, 400, 150, 600, 200, 800],
      data: {
        alertId: alert.id,
        type: alert.type,
        url: '/dashboard?alert=' + alert.id,
        receivedAt: new Date().toISOString()
      },
      actions: [
        { action: 'ack', title: '❤️ Am văzut, sunt aici!' },
        { action: 'open', title: 'Deschide Panou' }
      ]
    });

    // Send to all subscriptions in parallel with retries
    const pushPromises = subscriptions.map(async (sub) => {
      try {
        await this.sendWithRetry(sub, payload);
        await db.updateSubscriptionHealth(sub.endpoint, true);
        results.successCount++;
      } catch (err) {
        results.failCount++;
        const statusCode = err.statusCode || (err.endpoint ? 'Network' : 'Unknown');
        results.errors.push({
          endpoint: sub.endpoint.substring(0, 45) + '...',
          deviceName: sub.deviceName,
          status: statusCode,
          message: err.message
        });

        // If subscription is 404 or 410 Gone, remove expired token
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log(`🧹 Removing expired subscription (${sub.deviceName}): ${sub.endpoint.substring(0, 30)}...`);
          await db.removeSubscription(sub.endpoint);
          await db.addLog('info', `Abonament expirat eliminat (${sub.deviceName})`);
        } else {
          await db.updateSubscriptionHealth(sub.endpoint, false);
          await db.addLog('error', `Eșec push către ${sub.deviceName}: ${err.message}`);
        }
      }
    });

    await Promise.all(pushPromises);

    // Also send via Telegram Bot if configured
    const tgResult = await this.sendTelegramAlert(alert);
    if (tgResult && tgResult.sent) {
      results.telegram = true;
    }

    // Also send via WhatsApp (CallMeBot) if configured
    const waResult = await this.sendWhatsAppAlert(alert);
    if (waResult && waResult.sent) {
      results.whatsapp = true;
    }

    await db.addLog(
      results.failCount > 0 ? 'warn' : 'info',
      `Push trimis pentru alerta "${alert.title}": ${results.successCount}/${results.total} reușite (Valul 1)`,
      results
    );

    // RAFALĂ DE ALERTE (Push Burst Wave 2 & 3):
    // Trimite încă 2 notificări la 4s și 8s distanță pentru a insista până când el confirmă
    this.scheduleBurstAlert(alert, 2, 4000);
    this.scheduleBurstAlert(alert, 3, 9000);

    return results;
  }

  /**
   * Schedule subsequent burst alerts to wake up the phone if not yet acknowledged
   */
  scheduleBurstAlert(alert, burstIndex, delayMs) {
    setTimeout(async () => {
      try {
        const fresh = db.getAlertById(alert.id);
        if (!fresh || fresh.status === 'acknowledged') {
          // Boyfriend already acknowledged, abort burst!
          return;
        }

        const subscriptions = db.getSubscriptions();
        if (subscriptions.length === 0) return;

        const burstTitles = [
          '',
          '',
          `🚨 URGENT (${burstIndex}/3): Iubita ta te așteaptă!`,
          `🚨 (${burstIndex}/3): Te rog răspunde-i iubitei tale! ❤️`
        ];

        const payload = JSON.stringify({
          title: burstTitles[burstIndex] || `🚨 (${burstIndex}/3) ${alert.title}`,
          body: `Iubita ta are nevoie de tine chiar acum!\n⏰ ${alert.timeOnly || ''}`,
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
          tag: `heart-alert-${alert.id}-b${burstIndex}`, // New tag forces iOS to play another sound and vibration
          renotify: true,
          requireInteraction: true,
          vibrate: [500, 150, 500, 150, 700],
          data: {
            alertId: alert.id,
            url: '/dashboard?alert=' + alert.id
          },
          actions: [
            { action: 'ack', title: '❤️ Am văzut, sunt aici!' },
            { action: 'open', title: 'Deschide Panou' }
          ]
        });

        await Promise.all(subscriptions.map(s => this.sendWithRetry(s, payload).catch(() => {})));
        await db.addLog('info', `Rafală alertă trimisă: Valul ${burstIndex}/3 pentru "${alert.title}"`);
      } catch (e) {
        console.warn('Burst alert error:', e.message);
      }
    }, delayMs);
  }

  /**
   * Free WhatsApp Notification via CallMeBot API
   */
  async sendWhatsAppAlert(alert) {
    try {
      const settings = db.getSettings();
      if (!settings.whatsappNumber || !settings.whatsappApiKey) {
        return { sent: false, reason: 'not_configured' };
      }

      const text = `🚨 *PENTRU INIMA MEA - ALERTĂ!* 🚨\n\n` +
                   `❤️ *${alert.title}*\n` +
                   `💬 *Mesaj:* ${alert.message}\n` +
                   (alert.note ? `📝 *Notă de la ea:* "${alert.note}"\n` : '') +
                   `⏰ *Ora:* ${alert.timeOnly}\n\n` +
                   `Intră și răspunde-i: https://snake-manhattan-budapest-myth.trycloudflare.com/dashboard.html`;

      const encodedText = encodeURIComponent(text);
      const phone = settings.whatsappNumber.replace(/[^0-9+]/g, '');
      const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodedText}&apikey=${settings.whatsappApiKey}`;

      return await new Promise((resolve) => {
        https.get(url, (res) => {
          if (res.statusCode === 200) {
            resolve({ sent: true });
          } else {
            resolve({ sent: false, status: res.statusCode });
          }
        }).on('error', (e) => resolve({ sent: false, error: e.message }));
      });
    } catch (e) {
      return { sent: false, error: e.message };
    }
  }

  /**
   * Send test push to a specific subscription or all
   */
  async sendTestPush(subscription, customMessage = 'Aceasta este o notificare de test pe iPhone!') {
    const payload = JSON.stringify({
      title: '❤️ Test Notificare - Pentru Inima Mea',
      body: customMessage + '\nSistemul de alertă funcționează perfect! 🎉',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'heart-test-' + Date.now(),
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: {
        url: '/dashboard',
        test: true
      }
    });

    const pushSubscription = {
      endpoint: subscription.endpoint,
      keys: subscription.keys
    };

    const wp = await getWebPush();
    return await wp.sendNotification(pushSubscription, payload, {
      urgency: 'high',
      TTL: 86400 // 24 hours
    });
  }

  /**
   * Helper retry logic with exponential backoff and Apple Priority 10
   */
  async sendWithRetry(sub, payload, maxRetries = 2) {
    const wp = await getWebPush();
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: sub.keys
    };

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        return await wp.sendNotification(pushSubscription, payload, {
          urgency: 'high',
          TTL: 86400,
          topic: 'heart-alert',
          headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert'
          }
        });
      } catch (err) {
        attempt++;
        if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
          throw err;
        }
        if (attempt > maxRetries) {
          throw err;
        }
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }
  }

  /**
   * Telegram Bot notification for companion alert
   */
  async sendTelegramAlert(alert) {
    try {
      const settings = db.getSettings();
      if (!settings.telegramBotToken || !settings.telegramChatId) {
        return { sent: false, reason: 'not_configured' };
      }

      const urgencyEmoji = alert.type === 'overthinking' ? '🥺' :
                           alert.type === 'sad' ? '💔' :
                           alert.type === 'hug' ? '🫂' :
                           alert.type === 'miss' ? '❤️' :
                           alert.type === 'sleep' ? '🌙' :
                           alert.type === 'sick' ? '😔' :
                           alert.type === 'talk' ? '💌' : '🚨';

      const text = `${urgencyEmoji} *PENTRU INIMA MEA - ALERTĂ!*\n\n` +
                   `*Tip:* ${alert.title}\n` +
                   `*Mesaj:* ${alert.message}\n` +
                   (alert.note ? `*Notă personală:* _"${alert.note}"_\n` : '') +
                   `*Ora:* ${alert.timestampFormatted}\n\n` +
                   `❤️ Intră în aplicație pentru a-i răspunde: "Am văzut, sunt aici!"`;

      const postData = JSON.stringify({
        chat_id: settings.telegramChatId,
        text: text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      return await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${settings.telegramBotToken}/sendMessage`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 5000
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve({ sent: true });
            } else {
              console.warn('Telegram send failed:', res.statusCode, body);
              resolve({ sent: false, error: body });
            }
          });
        });

        req.on('error', (e) => {
          console.warn('Telegram request error:', e.message);
          resolve({ sent: false, error: e.message });
        });

        req.write(postData);
        req.end();
      });
    } catch (e) {
      console.warn('Telegram alert exception:', e.message);
      return { sent: false, error: e.message };
    }
  }
}

module.exports = new PushService();
