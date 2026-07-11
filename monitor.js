/*
 * Мониторинг сайта контракт-бюро.рф
 * Каждый запуск проходит путь посетителя: загрузка страницы, кнопки,
 * заполнение и отправка формы консультации. При ошибке шлёт алерт в Telegram.
 *
 * Реальная отправка заявки НЕ происходит: запрос к api.telegram.org
 * перехватывается внутри браузера и подменяется фейковым ответом,
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

const errors = [];   // проваленные проверки
const warnings = []; // не критично, но стоит знать

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

(async () => {
  console.log('Проверка ' + SITE_URL + ' — ' + new Date().toISOString());
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', e => consoleErrors.push(String(e.message).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('requestfailed', r => {
    // Видео и метрика могут обрываться легитимно — интересны скрипты и стили
    const type = r.resourceType();
    if (type === 'script' || type === 'stylesheet') {
      failedRequests.push(r.url().slice(0, 120) + ' (' + (r.failure() || {}).errorText + ')');
    }
  });

  // Перехват заявок: сайт шлёт лиды через api.telegram.org — подменяем ответ,
  // чтобы тестовая заявка НЕ приходила менеджерам, но канал отправки проверялся.
  const capturedLeads = [];
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
    await page.waitForTimeout(4000); // даём догрузиться скриптам и анимациям

    // ── 2. Внешние библиотеки (CDN) ──
    const libs = await page.evaluate(() => ({
      gsap: typeof gsap !== 'undefined',
      typed: typeof Typed !== 'undefined',
      swiper: typeof Swiper !== 'undefined',
      openLeadForm: typeof openLeadForm === 'function'
    }));
    if (!libs.openLeadForm) fail('Основной скрипт сайта не выполнился (openLeadForm не определён)');
    else ok('Основной скрипт сайта работает');
    for (const [lib, loaded] of [['gsap', libs.gsap], ['Typed', libs.typed], ['Swiper', libs.swiper]]) {
      if (!loaded) warn('Библиотека ' + lib + ' не загрузилась с CDN');
    }
    if (failedRequests.length) warn('Не загрузились ресурсы', failedRequests.join('; ').slice(0, 300));

    // Принимаем cookie-баннер, как настоящий посетитель — иначе он
    // легитимно перекрывает низ страницы и портит проверку перекрытий
    try {
      const cookieBtn = page.locator('.cookie-accept');
      if (await cookieBtn.isVisible({ timeout: 2000 })) {
        await cookieBtn.click();
        await page.waitForTimeout(600);
      }
    } catch (e) {}

    // ── 3. Кнопки не перекрыты невидимыми слоями ──
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

    // ── 4. Открытие формы консультации ──
    const heroBtn = page.locator('.btn-hero-main').first();
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

        // ── 5. Заполнение и отправка ──
        await page.fill('#lf-name', 'ТЕСТ Мониторинг');
        await page.fill('#lf-phone', '9990000000'); // маска сайта сама добавит +7 и скобки
        const phoneVal = await page.inputValue('#lf-phone');
        if (!phoneVal || phoneVal.replace(/\D/g, '').length < 11) {
          fail('Маска телефона работает неверно', 'в поле осталось: «' + phoneVal + '»');
        } else {
          ok('Поля заполняются, маска телефона работает');
        }

        // Обязательная галочка согласия с политикой
        const consent = page.locator('#lead-form .card-consent input[type=checkbox]');
        if (await consent.count()) await consent.check();

        await page.click('#lead-form .card-submit');
        await page.waitForTimeout(3000);

        if (!capturedLeads.length) {
          fail('Заявка НЕ отправилась (запрос к Telegram не ушёл)');
        } else {
          const sent = JSON.stringify(capturedLeads);
          if (sent.includes('ТЕСТ Мониторинг') && sent.replace(/\D/g, '').includes('9990000000')) {
            ok('Заявка отправляется, данные в ней корректны (' + capturedLeads.length + ' получателей)');
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

    // ── 6. Ошибки JavaScript на странице ──
    const realErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('mc.yandex') && !e.includes('ERR_BLOCKED_BY_CLIENT'));
    if (realErrors.length) warn('Ошибки JS в консоли', [...new Set(realErrors)].slice(0, 3).join(' | '));
    else ok('Ошибок JavaScript нет');

  } catch (e) {
    if (e.message !== 'abort') fail('Неожиданный сбой проверки', e.message.slice(0, 200));
  }

  // ── Итог ──
  if (errors.length) {
    try { await page.screenshot({ path: SCREENSHOT, fullPage: false }); } catch (e) {}
    const msg = '🔴 <b>Сайт контракт-бюро.рф: проблема!</b>\n\n' +
      errors.map(e => '❌ ' + e).join('\n') +
      (warnings.length ? '\n\n' + warnings.map(w => '⚠️ ' + w).join('\n') : '') +
      '\n\n🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК';
    await sendAlert(msg, SCREENSHOT);
    console.log('\nИТОГ: ПРОБЛЕМЫ НАЙДЕНЫ (' + errors.length + ')');
    await browser.close();
    process.exit(1);
  } else {
    console.log('\nИТОГ: всё работает' + (warnings.length ? ' (предупреждений: ' + warnings.length + ')' : ''));
    await browser.close();
    process.exit(0);
  }
})();
