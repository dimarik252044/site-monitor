/*
 * Мониторинг сайта контракт-бюро.рф
 * Сам определяет версию сайта (старая тёмная / новая светлая) и проходит
 * путь посетителя: загрузка, кнопки, заполнение и отправка формы, квиз.
 * При ошибке шлёт алерт в Telegram.
 *
 * Реальные заявки НЕ отправляются: запросы к lead.php и api.telegram.org
 * перехватываются внутри браузера и подменяются фейковым ответом,
 * при этом содержимое запроса проверяется на корректность.
 *
 * Переменные окружения:
 *   TG_TOKEN      — токен бота для алертов
 *   ALERT_CHAT_ID — chat_id, куда слать алерты
 *   SITE_URL      — адрес сайта (по умолчанию контракт-бюро.рф)
 */
const { chromium } = require('playwright');
const fs = require('fs');

const SITE_URL = process.env.SITE_URL || 'https://xn----7sbe7abqgfneqd2n.xn--p1ai/';
const TG_TOKEN = process.env.TG_TOKEN || '';
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || '';
const SCREENSHOT = 'failure.png';

const errors = [];
const warnings = [];

function ok(name) { console.log('  ✅ ' + name); }
function fail(name, detail) {
  console.log('  ❌ ' + name + (detail ? ' — ' + detail : ''));
  errors.push(name + (detail ? ': ' + detail : ''));
}
function warn(name, detail) {
  console.log('  ⚠️  ' + name + (detail ? ' — ' + detail : ''));
  warnings.push(name + (detail ? ': ' + detail : ''));
}

async function sendAlert(text, screenshotPath) {
  if (!TG_TOKEN || !ALERT_CHAT_ID) {
    console.log('TG_TOKEN/ALERT_CHAT_ID не заданы — алерт не отправлен');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALERT_CHAT_ID, text, parse_mode: 'HTML' })
    });
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const form = new FormData();
      form.append('chat_id', ALERT_CHAT_ID);
      form.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'failure.png');
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: 'POST', body: form });
    }
  } catch (e) {
    console.log('Не удалось отправить алерт: ' + e.message);
  }
}

// Упал ли предыдущий запуск в GitHub Actions (репозиторий публичный — токен не нужен).
// Нужно, чтобы после алерта прислать «восстановился». Вне Actions всегда false.
async function prevRunFailed() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return false;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/runs?status=completed&per_page=1`,
      { headers: { 'User-Agent': 'site-monitor' } }
    );
    const d = await r.json();
    return !!(d.workflow_runs && d.workflow_runs[0] && d.workflow_runs[0].conclusion === 'failure');
  } catch (e) {
    return false;
  }
}

async function runChecks() {
  errors.length = 0;
  warnings.length = 0;
  console.log('Проверка ' + SITE_URL + ' — ' + new Date().toISOString());
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  // Попап-лидмагнит новой версии не должен мешать проверкам
  await page.addInitScript(() => {
    try { sessionStorage.setItem('promoPopupShown', '1'); } catch (e) {}
  });

  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', e => consoleErrors.push(String(e.message).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('requestfailed', r => {
    const type = r.resourceType();
    if (type === 'script' || type === 'stylesheet') {
      failedRequests.push(r.url().slice(0, 120) + ' (' + (r.failure() || {}).errorText + ')');
    }
  });

  // Перехват заявок: и серверный приёмник lead.php, и прямую отправку в Telegram.
  // Тестовая заявка не доходит ни до менеджеров, ни до CRM.
  const capturedLeads = [];
  await page.route('**/lead.php', async route => {
    try { capturedLeads.push(JSON.parse(route.request().postData() || '{}')); } catch (e) {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api.telegram.org/**', async route => {
    try { capturedLeads.push(JSON.parse(route.request().postData() || '{}')); } catch (e) {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"result":{}}' });
  });

  try {
    // ── 1. Загрузка страницы ──
    let resp;
    try {
      resp = await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      fail('Сайт не открылся за 45 секунд', e.message.slice(0, 120));
      throw new Error('abort');
    }
    if (!resp || resp.status() !== 200) {
      fail('Сайт вернул код ' + (resp ? resp.status() : '—'));
      throw new Error('abort');
    }
    ok('Страница открылась (HTTP 200)');
    await page.waitForTimeout(4000);

    // ── 1.5 Срок SSL-сертификата ──
    if (SITE_URL.startsWith('https://')) {
      const tls = require('tls');
      const host = new URL(SITE_URL).hostname;
      await new Promise(resolve => {
        const sock = tls.connect(443, host, { servername: host, timeout: 10000 }, () => {
          const cert = sock.getPeerCertificate();
          if (cert && cert.valid_to) {
            const days = Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000);
            if (days < 0) fail('SSL-сертификат ИСТЁК — браузеры пугают посетителей');
            else if (days <= 14) fail('SSL-сертификат истекает через ' + days + ' дн.', 'продлите на хостинге заранее');
            else ok('SSL-сертификат в порядке (действует ещё ' + days + ' дн.)');
          }
          sock.end(); resolve();
        });
        sock.on('error', () => { warn('Не удалось проверить SSL-сертификат'); resolve(); });
        sock.on('timeout', () => { sock.destroy(); resolve(); });
      });
    }

    // ── 2. Определяем версию сайта ──
    const isNew = await page.evaluate(() => !!document.getElementById('quiz-card'));
    console.log('  ℹ️  Версия сайта: ' + (isNew ? 'новая (светлая, с квизом)' : 'старая (тёмная, с видео)'));

    // ── 3. Основной скрипт и библиотеки ──
    const env = await page.evaluate(() => ({
      openLeadForm: typeof openLeadForm === 'function',
      gsap: typeof gsap !== 'undefined',
      typed: typeof Typed !== 'undefined'
    }));
    if (!env.openLeadForm) fail('Основной скрипт сайта не выполнился (openLeadForm не определён)');
    else ok('Основной скрипт сайта работает');
    if (!isNew) {
      // старая версия зависит от CDN-библиотек
      if (!env.gsap) warn('Библиотека gsap не загрузилась с CDN');
      if (!env.typed) warn('Библиотека Typed не загрузилась с CDN');
    }
    if (failedRequests.length) warn('Не загрузились ресурсы', failedRequests.join('; ').slice(0, 300));

    // Принимаем cookie-баннер, как настоящий посетитель
    try {
      const cookieBtn = page.locator('.cookie-accept');
      if (await cookieBtn.isVisible({ timeout: 2000 })) {
        await cookieBtn.click();
        await page.waitForTimeout(600);
      }
    } catch (e) {}

    // ── 4. Кнопки не перекрыты невидимыми слоями ──
    const blocked = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('button, a.btn, [onclick]').forEach(b => {
        const r = b.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
        const el = document.elementFromPoint(cx, cy);
        if (el && !b.contains(el) && !el.contains(b)) {
          bad.push((b.textContent || b.className).trim().slice(0, 30) + ' перекрыта ' + el.tagName + '.' + String(el.className).slice(0, 30));
        }
      });
      return bad;
    });
    if (blocked.length) fail('Кнопки перекрыты невидимым слоем', blocked.join('; '));
    else ok('Кнопки первого экрана кликабельны');

    // ── 5. Открытие формы консультации ──
    const ctaSelector = isNew ? '.hero-actions .btn' : '.btn-hero-main';
    const heroBtn = page.locator(ctaSelector).first();
    if (await heroBtn.count() === 0) {
      fail('Кнопка «Получить консультацию» не найдена на странице');
    } else {
      await heroBtn.click({ timeout: 5000 });
      await page.waitForTimeout(700);
      const modalVisible = await page.evaluate(() => {
        const m = document.getElementById('lead-modal');
        return m && getComputedStyle(m).display !== 'none' && parseFloat(getComputedStyle(m).opacity) > 0.5;
      });
      if (!modalVisible) {
        fail('Форма консультации не открылась по клику');
      } else {
        ok('Форма консультации открывается');

        // ── 6. Заполнение и отправка ──
        await page.fill('#lf-name', 'ТЕСТ Мониторинг');
        await page.fill('#lf-phone', '9990000000'); // маска сайта сама добавит +7
        const phoneVal = await page.inputValue('#lf-phone');
        if (!phoneVal || phoneVal.replace(/\D/g, '').length < 11) {
          fail('Маска телефона работает неверно', 'в поле осталось: «' + phoneVal + '»');
        } else {
          ok('Поля заполняются, маска телефона работает');
        }

        const consent = page.locator('#lead-form .card-consent input[type=checkbox]');
        if (await consent.count()) await consent.check();

        await page.click('#lead-form .card-submit');
        await page.waitForTimeout(3000);

        if (!capturedLeads.length) {
          fail('Заявка НЕ отправилась (запрос не ушёл ни в lead.php, ни в Telegram)');
        } else {
          const sent = JSON.stringify(capturedLeads);
          if (sent.includes('ТЕСТ Мониторинг') && sent.replace(/\D/g, '').includes('9990000000')) {
            ok('Заявка отправляется, данные корректны (' + (isNew ? 'через lead.php → CRM' : 'напрямую в Telegram') + ')');
          } else {
            fail('Заявка ушла, но данные в ней битые', sent.slice(0, 200));
          }
        }

        const successShown = await page.evaluate(() => {
          const m = document.getElementById('success-modal');
          return m && m.style.display === 'flex';
        });
        if (!successShown) warn('Окно «Заявка принята» не показалось после отправки');
        else ok('Посетитель видит подтверждение «Заявка принята»');

        await page.evaluate(() => {
          const s = document.getElementById('success-modal');
          if (s) s.style.display = 'none';
          if (typeof closeLeadForm === 'function') closeLeadForm();
        });
        await page.waitForTimeout(500);
      }
    }

    // ── 6.5 Серверный приёмник заявок (только новая версия) ──
    // Не создаём заявку: GET к lead.php должен вернуть «method»,
    // lead-export.php без токена — «forbidden». Это доказывает, что PHP жив.
    if (isNew) {
      try {
        const base = new URL(SITE_URL).origin;
        const [leadPhp, exportPhp] = await Promise.all([
          fetch(base + '/lead.php').then(r => r.json()).catch(() => null),
          fetch(base + '/lead-export.php').then(r => r.json()).catch(() => null)
        ]);
        if (leadPhp && leadPhp.error === 'method' && exportPhp && exportPhp.error === 'forbidden') {
          ok('Серверный приёмник заявок (lead.php + выгрузка в CRM) жив');
        } else {
          fail('Серверный приёмник заявок не отвечает как положено',
            'lead.php: ' + JSON.stringify(leadPhp).slice(0, 60) + ' | export: ' + JSON.stringify(exportPhp).slice(0, 60));
        }
      } catch (e) {
        fail('Не удалось проверить lead.php', e.message.slice(0, 100));
      }
    }

    // ── 7. Квиз (только новая версия) ──
    if (isNew) {
      try {
        for (let i = 0; i < 4; i++) {
          await page.locator('#quiz-card .qz-opt').first().click({ timeout: 3000 });
          await page.waitForTimeout(250);
        }
        const quizDone = await page.evaluate(() =>
          (document.getElementById('quiz-card').textContent || '').includes('подходят'));
        if (quizDone) ok('Квиз проходится до результата');
        else fail('Квиз не дошёл до результата за 4 ответа');
      } catch (e) {
        fail('Квиз не работает', e.message.slice(0, 100));
      }
    }

    // ── 8. Ошибки JavaScript ──
    const realErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('mc.yandex') && !e.includes('ERR_BLOCKED_BY_CLIENT'));
    if (realErrors.length) warn('Ошибки JS в консоли', [...new Set(realErrors)].slice(0, 3).join(' | '));
    else ok('Ошибок JavaScript нет');

  } catch (e) {
    if (e.message !== 'abort') fail('Неожиданный сбой проверки', e.message.slice(0, 200));
  }

  // ── Итог прохода ──
  if (errors.length) {
    try { await page.screenshot({ path: SCREENSHOT, fullPage: false }); } catch (e) {}
  }
  await browser.close();
  return { errors: [...errors], warnings: [...warnings] };
}

(async () => {
  // Защита от ложных тревог: одиночный сбой (секундный лаг хостинга) не считается.
  // Алерт уходит только если проблема подтвердилась двумя проходами с паузой в минуту.
  const first = await runChecks();
  let result = first;
  if (first.errors.length) {
    console.log('\nНайдены проблемы — перепроверка через 60 секунд…');
    await new Promise(r => setTimeout(r, 60_000));
    result = await runChecks();
  }

  if (result.errors.length) {
    const msg = '🔴 <b>Сайт контракт-бюро.рф: проблема!</b>\n\n' +
      result.errors.map(e => '❌ ' + e).join('\n') +
      (result.warnings.length ? '\n\n' + result.warnings.map(w => '⚠️ ' + w).join('\n') : '') +
      '\n\n⏱ Подтверждено двумя проверками с интервалом в минуту' +
      '\n🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК';
    await sendAlert(msg, SCREENSHOT);
    console.log('\nИТОГ: ПРОБЛЕМЫ ПОДТВЕРЖДЕНЫ (' + result.errors.length + ')');
    process.exit(1);
  }

  if (first.errors.length) {
    console.log('\nИТОГ: сбой был кратковременным, вторая проверка прошла — алерт не отправлен');
  }
  // Прошлый запуск закончился алертом, а сейчас всё хорошо — сообщаем, что беспокоиться не о чем
  if (await prevRunFailed()) {
    await sendAlert('✅ <b>Сайт контракт-бюро.рф: восстановился</b>\n\nВсе проверки снова проходят, ничего делать не нужно.' +
      '\n\n🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК');
  }
  console.log('\nИТОГ: всё работает' + (result.warnings.length ? ' (предупреждений: ' + result.warnings.length + ')' : ''));
  process.exit(0);
})();
