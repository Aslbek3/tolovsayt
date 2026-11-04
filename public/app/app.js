// Telegram Mini App — mijoz kabinetining SPA ko'rinishi.
// Qurilish qadamisiz, vanilla JS. Har bir ekran template-string orqali
// generatsiya qilinadi va innerHTML bilan joylashtiriladi (kichik ilova uchun yetarli).
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) {}
  }
  if (tg && tg.themeParams) {
    try {
      if (tg.colorScheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    } catch (e) {}
  }
  try { tg && tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}

  var root = document.getElementById('root');
  var initData = (tg && tg.initData) || '';

  // ------------------------------------------------------------------ API

  async function api(path, body) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Tg-Init-Data': initData, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || ('http_' + res.status));
      err.data = data;
      throw err;
    }
    return data;
  }

  async function apiForm(path, formData) {
    var res = await fetch(path, { method: 'POST', headers: { 'X-Tg-Init-Data': initData }, body: formData });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || ('http_' + res.status));
      err.data = data;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------- yordamchi

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function money(n) {
    return Number(n || 0).toLocaleString('ru-RU').replace(/ /g, ' ') + " so'm";
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    var parts = String(dateStr).slice(0, 10).split('-');
    if (parts.length !== 3) return String(dateStr);
    return parts[2] + '.' + parts[1] + '.' + parts[0];
  }

  function parseDate(dateStr) {
    var p = String(dateStr).slice(0, 10).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function daysLeft(paidUntil) {
    var now = new Date();
    var today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((parseDate(paidUntil) - today0) / 86400000);
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('mini-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mini-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function bindCopy(container) {
    container.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var raw = (btn.getAttribute('data-copy') || '').replace(/\s+/g, '');
        copyText(raw).then(function () {
          toast('Karta raqami nusxalandi');
        }).catch(function () {
          toast("Nusxalanmadi — raqamni qo'lda yozib oling");
        });
      });
    });
  }

  function bindMonthChips(formEl) {
    if (!formEl) return;
    var price = Number(formEl.getAttribute('data-price') || 0);
    function sync() {
      var picked = formEl.querySelector('input[name="months"]:checked');
      if (!picked) return;
      var months = Number(picked.value || 1);
      var totalEl = formEl.querySelector('[data-total]');
      if (totalEl) totalEl.textContent = money(price * months);
      var noteEl = formEl.querySelector('[data-total-note]');
      if (noteEl) noteEl.textContent = months + ' oy uchun';
    }
    formEl.addEventListener('change', function (e) { if (e.target.name === 'months') sync(); });
    sync();
  }

  function bindFilePick(container) {
    container.querySelectorAll('.file-pick').forEach(function (pick) {
      var input = pick.querySelector('input[type="file"]');
      var prev = pick.querySelector('.file-prev');
      if (!input || !prev) return;

      var img = prev.querySelector('img');
      var pdf = prev.querySelector('.pdf');
      var nameEl = prev.querySelector('.meta b');
      var sizeEl = prev.querySelector('.meta span');

      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) { pick.classList.remove('has'); return; }

        if (nameEl) nameEl.textContent = f.name;
        if (sizeEl) sizeEl.textContent = f.size < 1048576
          ? Math.max(1, Math.round(f.size / 1024)) + ' KB'
          : (f.size / 1048576).toFixed(1) + ' MB';

        var isImg = /^image\//.test(f.type);
        if (img) img.style.display = isImg ? '' : 'none';
        if (pdf) pdf.style.display = isImg ? 'none' : '';
        if (isImg && img) {
          if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
          var url = URL.createObjectURL(f);
          img.dataset.url = url;
          img.src = url;
        }
        pick.classList.add('has');
      });

      var rm = prev.querySelector('.rm');
      if (rm) rm.addEventListener('click', function (e) {
        e.preventDefault();
        input.value = '';
        if (img && img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; img.removeAttribute('src'); }
        pick.classList.remove('has');
      });
    });
  }

  function bankCardHtml(settings) {
    settings = settings || {};
    return '' +
      '<div class="bank-card">' +
        '<button type="button" class="cp" data-copy="' + esc(settings.card_number || '') + '">Nusxalash</button>' +
        '<span class="chip" aria-hidden="true"></span>' +
        '<div class="lbl">' + esc(settings.card_bank || '') + ' kartasi</div>' +
        '<div class="num">' + esc(settings.card_number || '') + '</div>' +
        '<div class="foot">' +
          '<div class="who">' + esc(settings.card_holder || '') + '</div>' +
          '<div class="bank">' + esc(settings.card_bank || '') + '</div>' +
        '</div>' +
      '</div>';
  }

  function tabbar(active) {
    function cls(name) { return name === active ? 'on' : ''; }
    return '' +
      '<nav class="tabbar">' +
        '<a href="#/" class="' + cls('home') + '"><span class="ic">🏠</span>Asosiy</a>' +
        '<a href="#/payments" class="' + cls('payments') + '"><span class="ic">🧾</span>To\'lovlar</a>' +
        '<a href="#/profile" class="' + cls('profile') + '"><span class="ic">👤</span>Profil</a>' +
      '</nav>';
  }

  function svcCardHtml(s, pend) {
    var left = daysLeft(s.paid_until);
    var suspended = s.status === 'suspended';
    var urgent = suspended || left < 0;
    var soon = !urgent && left <= 3;
    var cls = urgent ? 'is-urgent' : (soon ? 'is-soon' : '');
    var pct = urgent ? 100 : Math.max(0, Math.min(100, Math.round(left / 30 * 100)));
    var leftText = suspended ? "To'xtatilgan" : left < 0 ? ((-left) + " kun o'tdi") : left === 0 ? 'Bugun tugaydi' : (left + ' kun qoldi');
    var badge = suspended ? '<span class="badge red">To\'xtatilgan</span>'
      : left < 0 ? ('<span class="badge red">' + (-left) + " kun o'tdi</span>")
      : left <= 3 ? ('<span class="badge amber">' + (left === 0 ? 'Bugun' : left + ' kun qoldi') + '</span>')
      : ('<span class="badge green">' + left + ' kun qoldi</span>');

    return '' +
      '<div class="c-svc ' + cls + '">' +
        '<div class="hd">' +
          '<div class="ico ' + (s.type === 'sayt' ? 'ico-site' : 'ico-bot') + '">' + (s.type === 'sayt' ? '🌐' : '🤖') + '</div>' +
          '<div class="nm"><b>' + esc(s.name) + '</b><div class="sub"><b>' + money(s.price) + '</b> / oy</div></div>' +
          badge +
        '</div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="ft">' +
          '<div class="when">' + leftText + ' · <b>' + fmtDate(s.paid_until) + '</b> gacha</div>' +
          (pend ? '' : ('<a class="btn" href="#/pay/' + s.id + '">To\'lash</a>')) +
        '</div>' +
        (pend
          ? ('<div class="c-pending"><span class="dot"></span><span>Chek tekshirilmoqda · ' + money(pend.amount) + '</span></div>')
          : '') +
      '</div>';
  }

  // ------------------------------------------------------------- holat

  var session = null;
  var sessionAt = 0;
  var CACHE_MS = 25000;

  async function loadSession(force) {
    var now = Date.now();
    if (!force && session && (now - sessionAt) < CACHE_MS) return session;
    session = await api('/tg/session');
    sessionAt = now;
    return session;
  }

  // ------------------------------------------------------------- ekranlar

  function renderLoading() {
    root.innerHTML = '<div class="loading"><div class="spin"></div></div>';
  }

  function renderErrorScreen(message) {
    root.innerHTML = '' +
      '<div class="screen"><div class="c-link-screen">' +
        '<div class="mark">!</div>' +
        '<h1>Xatolik</h1>' +
        '<p>' + esc(message) + '</p>' +
        '<button class="btn full" id="retry-btn" type="button">Qayta urinish</button>' +
      '</div></div>';
    var btn = document.getElementById('retry-btn');
    if (btn) btn.addEventListener('click', function () { boot(); });
  }

  function renderLink(err) {
    root.innerHTML = '' +
      '<div class="screen"><div class="c-link-screen">' +
        '<div class="mark">₿</div>' +
        '<h1>Xush kelibsiz</h1>' +
        '<p>Kabinetga kirish uchun hisobingizni ulang. Tugmani bosing — Telegram botiga qaytib, so\'ralganda raqamingizni yuboring.</p>' +
        '<button class="btn full" id="link-btn" type="button">📱 Hisobni ulash</button>' +
        (err ? ('<div class="err">' + esc(err) + '</div>') : '') +
      '</div></div>';

    var btn = document.getElementById('link-btn');
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      btn.textContent = 'Yuborilmoqda…';
      try {
        var r = await api('/tg/request-contact');
        if (!r.ok) {
          renderLink(r.error === 'bot_not_started'
            ? "Avval botga /start yozing, keyin qayta urinib ko'ring."
            : "Xatolik yuz berdi, qayta urinib ko'ring.");
          return;
        }
        var msg = "Telegram botiga qaytdingiz — u raqamingizni so'raydi. Yuborganingizdan keyin Kabinetni qaytadan oching.";
        if (tg && tg.showAlert) {
          tg.showAlert(msg, function () { try { tg.close(); } catch (e) {} });
        } else {
          window.alert(msg);
        }
      } catch (e) {
        renderLink("Xatolik yuz berdi, qayta urinib ko'ring.");
      }
    });
  }

  function renderDashboard() {
    var s = session;
    var needAction = s.services.filter(function (x) { return x.status === 'suspended' || daysLeft(x.paid_until) <= 7; });
    var fine = s.services.filter(function (x) { return !(x.status === 'suspended' || daysLeft(x.paid_until) <= 7); });

    var html = '<main class="c-wrap">';
    html += '<div class="c-head"><div><div class="hi">Assalomu alaykum</div><div class="who">' + esc(s.client.name) + '</div></div></div>';

    html += '' +
      '<div class="c-balance">' +
        '<div class="lbl">Balans</div>' +
        '<div class="amt">' + money(s.balance) + '</div>' +
        '<div class="sub">' + (s.balance > 0 ? "Xizmatlarga chek yuklamasdan to'lashingiz mumkin" : "Oldindan pul kiritib qo'ysangiz, to'lov bir bosishda bo'ladi") + '</div>' +
        '<div class="acts"><a class="btn" href="#/topup">+ Hisobni to\'ldirish</a><a class="btn ghost" href="#/payments">Tarix</a></div>' +
      '</div>';

    if (s.rejected) {
      html += '' +
        '<div class="c-notice bad"><span class="ic">⚠️</span><div class="bd">' +
          '<b>To\'lovingiz rad etildi</b>' +
          esc(s.rejected.service_name) + ' — ' + money(s.rejected.amount) +
          (s.rejected.admin_note ? ('<div style="margin-top:4px">Sabab: ' + esc(s.rejected.admin_note) + '</div>') : '') +
          '<a class="btn red" href="#/pay/' + s.rejected.service_id + '">Qaytadan to\'lash</a>' +
        '</div></div>';
    }

    if (!s.services.length) {
      html += '' +
        '<div class="c-empty"><span class="em">📦</span><b>Sizda hali xizmat yo\'q</b>' +
          "Bot yoki sayt xizmati biriktirilgach, u shu yerda ko'rinadi." +
          (s.settings.admin_contact ? ('<a class="btn ghost" href="https://t.me/' + s.settings.admin_contact.replace('@', '') + '" target="_blank" rel="noopener">Admin bilan bog\'lanish</a>') : '') +
        '</div>';
    }

    if (needAction.length) {
      html += '<div class="c-section"><div class="cap urgent">To\'lash kerak <span class="count">' + needAction.length + '</span></div>';
      needAction.forEach(function (x) { html += svcCardHtml(x, s.pendingByService[x.id]); });
      html += '</div>';
    }
    if (fine.length) {
      html += '<div class="c-section"><div class="cap">Faol <span class="count">' + fine.length + '</span></div>';
      fine.forEach(function (x) { html += svcCardHtml(x, s.pendingByService[x.id]); });
      html += '</div>';
    }

    html += '</main>' + tabbar('home');
    root.innerHTML = html;
  }

  function renderPayments() {
    var history = session.payments;
    var badgeOf = { pending: ['amber', 'Tekshirilmoqda'], approved: ['green', 'Tasdiqlandi'], rejected: ['red', 'Rad etildi'] };

    var html = '<main class="c-wrap">';
    html += '' +
      '<div class="c-head"><div><div class="hi">Tarix</div><div class="who">To\'lovlar</div></div>' +
      '<a class="icon-btn" href="#/topup" title="Hisobni to\'ldirish">＋</a></div>';

    if (!history.length) {
      html += '' +
        '<div class="c-empty"><span class="em">🧾</span><b>Hali to\'lov yo\'q</b>' +
          "To'lov qilganingizdan keyin barcha cheklar shu yerda saqlanadi." +
          '<a class="btn ghost" href="#/">Xizmatlarimga qaytish</a></div>';
    } else {
      html += '<div class="c-list">';
      history.forEach(function (h) {
        var b = badgeOf[h.status] || ['gray', h.status];
        html += '' +
          '<div class="c-item">' +
            '<div class="ico">' + (h.kind === 'topup' ? '💰' : (h.type === 'sayt' ? '🌐' : '🤖')) + '</div>' +
            '<div class="bd">' +
              '<b>' + esc(h.kind === 'topup' ? "Hisobni to'ldirish" : h.service_name) + '</b>' +
              '<div class="sub">' + fmtDate(h.created_at) +
                (h.kind === 'payment' ? (' · ' + h.months + ' oy') : '') +
                (h.comment === "Balansdan to'landi" ? ' · balansdan' : '') +
              '</div>' +
              (h.status === 'rejected' && h.admin_note ? ('<div class="why">Sabab: ' + esc(h.admin_note) + '</div>') : '') +
            '</div>' +
            '<div class="rt"><div class="amt">' + money(h.amount) + '</div><span class="badge ' + b[0] + '">' + b[1] + '</span></div>' +
          '</div>';
      });
      html += '</div><p class="muted small center" style="margin-top:12px">Oxirgi ' + history.length + ' yozuv ko\'rsatilgan</p>';
    }

    html += '</main>' + tabbar('payments');
    root.innerHTML = html;
  }

  function renderProfile() {
    var me = session.client;
    var sm = session.summary;

    var html = '<main class="c-wrap">';
    html += '<div class="c-head"><div><div class="hi">Hisobim</div><div class="who">' + esc(me.name) + '</div></div></div>';

    html += '' +
      '<div class="c-section"><div class="cap">Ma\'lumotlar</div><div class="kv">' +
        '<div class="r"><span class="k">Telefon</span><span class="v">' + esc(me.phone) + '</span></div>' +
        '<div class="r"><span class="k">A\'zo bo\'lgan sana</span><span class="v">' + fmtDate(me.created_at) + '</span></div>' +
        '<div class="r"><span class="k">Balans</span><span class="v">' + money(sm.balance) + '</span></div>' +
      '</div></div>';

    html += '' +
      '<div class="c-section"><div class="cap">Statistika</div><div class="kv">' +
        '<div class="r"><span class="k">Jami xizmatlar</span><span class="v">' + sm.totalServices + '</span></div>' +
        '<div class="r"><span class="k">Faol / to\'xtatilgan</span><span class="v">' + sm.activeCount + ' / ' + sm.suspendedCount + '</span></div>' +
        '<div class="r"><span class="k">Jami to\'langan</span><span class="v">' + money(sm.totalPaid) + '</span></div>' +
        (sm.lastPaymentDate ? ('<div class="r"><span class="k">Oxirgi to\'lov</span><span class="v">' + fmtDate(sm.lastPaymentDate) + '</span></div>') : '') +
        (sm.nearestDue ? ('<div class="r"><span class="k">Eng yaqin muddat</span><span class="v">' + fmtDate(sm.nearestDue) + '</span></div>') : '') +
      '</div></div>';

    if (session.settings.admin_contact) {
      html += '<p class="muted small center" style="margin:0 0 14px">Savol bo\'lsa: ' +
        '<a href="https://t.me/' + session.settings.admin_contact.replace('@', '') + '" target="_blank" rel="noopener">' + esc(session.settings.admin_contact) + '</a></p>';
    }

    html += '</main>' + tabbar('profile');
    root.innerHTML = html;
  }

  function renderPay(idStr) {
    var id = Number(idStr);
    var service = (session.services || []).find(function (x) { return x.id === id; });
    if (!service) {
      location.hash = '#/';
      return;
    }

    var balance = session.balance;
    var months = [1, 3, 6, 12];
    var canBalance = balance >= service.price;
    var firstAffordable = months.find(function (m) { return balance >= service.price * m; }) || 1;

    var html = '<main class="c-wrap flow">';
    html += '<div class="flow-head"><a class="back" href="#/" aria-label="Orqaga">←</a><h1>To\'lov</h1></div>';

    html += '' +
      '<div class="c-svc"><div class="hd">' +
        '<div class="ico">' + (service.type === 'sayt' ? '🌐' : '🤖') + '</div>' +
        '<div class="nm"><b>' + esc(service.name) + '</b>' +
          '<div class="sub"><b>' + money(service.price) + '</b> / oy</div>' +
          '<div class="sub">' + fmtDate(service.paid_until) + ' gacha</div>' +
        '</div>' +
      '</div></div>';

    if (canBalance) {
      html += '<div class="c-section" style="margin-top:18px"><div class="cap">Balansdan to\'lash <span class="count">tez</span></div>';
      html += '<form class="card" id="balance-form" data-price="' + service.price + '">';
      html += '<div class="small muted">Balansingiz: <b>' + money(balance) + '</b> — chek yuklash va admin tasdiqlashi kerak emas, muddat darhol uzayadi.</div>';
      html += '<label>Necha oyga?</label><div class="chips">';
      months.forEach(function (m) {
        html += '<label class="chip"><input type="radio" name="months" value="' + m + '" ' +
          (balance < service.price * m ? 'disabled' : '') + ' ' + (m === firstAffordable ? 'checked' : '') + '>' +
          '<span>' + m + ' oy<i>' + money(service.price * m).replace(" so'm", '') + '</i></span></label>';
      });
      html += '</div>';
      html += '<div class="sum-card"><div class="lbl">Balansdan yechiladi</div><div class="big" data-total>' + money(service.price * firstAffordable) + '</div><div class="note" data-total-note>' + firstAffordable + ' oy uchun</div></div>';
      html += '<button class="btn full" type="submit">💰 Balansdan to\'lash</button></form></div>';
      html += '<div class="center muted small" style="margin:6px 0 16px">— yoki —</div>';
    }

    html += '<div class="c-section"><div class="cap">Kartaga o\'tkazib, chek yuklash</div>';
    html += '<form class="card" id="receipt-form" data-price="' + service.price + '">';
    html += '<label>Necha oyga to\'laysiz?</label><div class="chips">';
    months.forEach(function (m) {
      html += '<label class="chip"><input type="radio" name="months" value="' + m + '" ' + (m === 1 ? 'checked' : '') + '>' +
        '<span>' + m + ' oy<i>' + money(service.price * m).replace(" so'm", '') + '</i></span></label>';
    });
    html += '</div>';
    html += '<div class="sum-card"><div class="lbl">To\'lanadigan summa</div><div class="big" data-total>' + money(service.price) + '</div><div class="note" data-total-note>1 oy uchun</div><hr><div class="lbl">Shu kartaga o\'tkazing</div>' + bankCardHtml(session.settings) + '</div>';
    html += '' +
      '<label>Chek rasmi</label>' +
      '<div class="file-pick"><label class="zone"><input type="file" name="receipt" accept="image/*,.pdf" required>' +
        '<span class="em">🧾</span><b>Chek skrinshotini tanlang</b><span class="hint">JPG, PNG yoki PDF · 8 MB gacha</span></label>' +
        '<div class="file-prev"><img alt="chek"><div class="pdf" style="display:none">📄</div><div class="meta"><b></b><span></span></div><button type="button" class="rm" aria-label="O\'chirish">✕</button></div>' +
      '</div>';
    html += '<label>Izoh <span class="muted" style="font-weight:400">(ixtiyoriy)</span></label><input name="comment" placeholder="Masalan: Payme orqali to\'ladim">';
    html += '<button class="btn full" type="submit">Chekni yuborish</button>';
    if (session.settings.pay_note) html += '<p class="muted small center" style="margin:10px 0 0">' + esc(session.settings.pay_note) + '</p>';
    html += '</form></div>';

    html += '</main>';
    root.innerHTML = html;

    bindCopy(root);

    var balanceForm = document.getElementById('balance-form');
    if (balanceForm) {
      bindMonthChips(balanceForm);
      balanceForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (balanceForm.dataset.sent === '1') return;
        if (!window.confirm("Balansdan to'lashni tasdiqlaysizmi?")) return;

        var picked = balanceForm.querySelector('input[name="months"]:checked');
        var m = picked ? Number(picked.value) : 1;
        var btn = balanceForm.querySelector('button[type="submit"]');

        balanceForm.dataset.sent = '1';
        btn.disabled = true;
        btn.textContent = "To'lanmoqda…";

        try {
          var r = await api('/tg/pay-balance', { serviceId: service.id, months: m });
          if (r.ok) {
            toast("To'landi! Yangi muddat: " + r.paid_until);
            await loadSession(true);
            location.hash = '#/';
            dispatch();
          } else {
            toast(r.error || 'Xatolik');
            balanceForm.dataset.sent = '';
            btn.disabled = false;
            btn.textContent = "💰 Balansdan to'lash";
          }
        } catch (err) {
          toast('Xatolik yuz berdi');
          balanceForm.dataset.sent = '';
          btn.disabled = false;
          btn.textContent = "💰 Balansdan to'lash";
        }
      });
    }

    var receiptForm = document.getElementById('receipt-form');
    bindMonthChips(receiptForm);
    bindFilePick(receiptForm);
    receiptForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (receiptForm.dataset.sent === '1') return;

      var fileInput = receiptForm.querySelector('input[type="file"]');
      if (!fileInput.files || !fileInput.files[0]) { toast('Chek rasmini tanlang'); return; }

      var picked = receiptForm.querySelector('input[name="months"]:checked');
      var m = picked ? Number(picked.value) : 1;
      var comment = receiptForm.querySelector('input[name="comment"]').value;
      var btn = receiptForm.querySelector('button[type="submit"]');

      receiptForm.dataset.sent = '1';
      btn.disabled = true;
      btn.textContent = 'Yuborilmoqda…';

      var fd = new FormData();
      fd.append('serviceId', service.id);
      fd.append('months', m);
      fd.append('comment', comment);
      fd.append('receipt', fileInput.files[0]);

      try {
        var r = await apiForm('/tg/pay-receipt', fd);
        if (r.ok) {
          toast("Chek yuborildi! Admin tekshirib tasdiqlagach, muddat avtomatik uzayadi.");
          await loadSession(true);
          location.hash = '#/payments';
          dispatch();
        } else {
          toast(r.error || 'Xatolik');
          receiptForm.dataset.sent = '';
          btn.disabled = false;
          btn.textContent = 'Chekni yuborish';
        }
      } catch (err) {
        toast('Xatolik yuz berdi');
        receiptForm.dataset.sent = '';
        btn.disabled = false;
        btn.textContent = 'Chekni yuborish';
      }
    });
  }

  function renderTopup() {
    var html = '<main class="c-wrap flow">';
    html += '<div class="flow-head"><a class="back" href="#/" aria-label="Orqaga">←</a><h1>Hisobni to\'ldirish</h1></div>';
    html += '' +
      '<div class="c-notice info"><span class="ic">💡</span><div class="bd">' +
        "Qo'shgan summangiz admin tasdiqlagach balansga tushadi. Keyin xizmatlarga " +
        '<b style="display:inline">chek yuklamasdan</b>, bir bosishda to\'lashingiz mumkin.' +
      '</div></div>';

    html += '<form class="card" id="topup-form">';
    html += '<label for="tg-amount">Qancha pul qo\'shasiz?</label>';
    html += '<input id="tg-amount" name="amount" type="text" inputmode="numeric" autocomplete="off" placeholder="100 000" required>';
    html += '<div class="chips c3" style="margin-top:9px">';
    [50000, 100000, 200000].forEach(function (v) {
      html += '<button type="button" class="amt-chip" data-fill="' + v + '">' + money(v).replace(" so'm", '') + '</button>';
    });
    html += '</div>';
    html += '<div class="sum-card"><div class="lbl">Shu kartaga o\'tkazing</div>' + bankCardHtml(session.settings) + '</div>';
    html += '' +
      '<label>Chek rasmi</label>' +
      '<div class="file-pick"><label class="zone"><input type="file" name="receipt" accept="image/*,.pdf" required>' +
        '<span class="em">🧾</span><b>Chek skrinshotini tanlang</b><span class="hint">JPG, PNG yoki PDF · 8 MB gacha</span></label>' +
        '<div class="file-prev"><img alt="chek"><div class="pdf" style="display:none">📄</div><div class="meta"><b></b><span></span></div><button type="button" class="rm" aria-label="O\'chirish">✕</button></div>' +
      '</div>';
    html += '<label>Izoh <span class="muted" style="font-weight:400">(ixtiyoriy)</span></label><input name="comment" placeholder="Masalan: Payme orqali to\'ladim">';
    html += '<button class="btn full" type="submit">Chekni yuborish</button>';
    html += '</form>';
    html += '</main>';
    root.innerHTML = html;

    bindCopy(root);

    var form = document.getElementById('topup-form');
    var amountInput = form.querySelector('#tg-amount');
    bindFilePick(form);

    function markChips(digits) {
      root.querySelectorAll('[data-fill]').forEach(function (b) {
        b.classList.toggle('is-on', String(b.getAttribute('data-fill')) === digits);
      });
    }
    function fmtAmount() {
      var digits = amountInput.value.replace(/\D/g, '').slice(0, 12);
      amountInput.value = digits ? Number(digits).toLocaleString('ru-RU').replace(/ /g, ' ') : '';
      markChips(digits);
    }
    amountInput.addEventListener('input', fmtAmount);

    root.querySelectorAll('[data-fill]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        amountInput.value = Number(b.getAttribute('data-fill')).toLocaleString('ru-RU').replace(/ /g, ' ');
        amountInput.dispatchEvent(new Event('input'));
      });
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (form.dataset.sent === '1') return;

      var fileInput = form.querySelector('input[type="file"]');
      var amount = Math.max(0, parseInt(amountInput.value.replace(/\D/g, ''), 10) || 0);
      if (!amount || amount < 1000) { toast("To'g'ri summa kiriting (kamida 1 000 so'm)"); return; }
      if (!fileInput.files || !fileInput.files[0]) { toast('Chek rasmini tanlang'); return; }

      var btn = form.querySelector('button[type="submit"]');
      form.dataset.sent = '1';
      btn.disabled = true;
      btn.textContent = 'Yuborilmoqda…';

      var fd = new FormData();
      fd.append('amount', String(amount));
      fd.append('comment', form.querySelector('input[name="comment"]').value);
      fd.append('receipt', fileInput.files[0]);

      try {
        var r = await apiForm('/tg/topup-receipt', fd);
        if (r.ok) {
          toast("So'rov yuborildi! Admin tekshirib tasdiqlagach, balansingiz to'ldiriladi.");
          await loadSession(true);
          location.hash = '#/profile';
          dispatch();
        } else {
          toast(r.error || 'Xatolik');
          form.dataset.sent = '';
          btn.disabled = false;
          btn.textContent = 'Chekni yuborish';
        }
      } catch (err) {
        toast('Xatolik yuz berdi');
        form.dataset.sent = '';
        btn.disabled = false;
        btn.textContent = 'Chekni yuborish';
      }
    });
  }

  // --------------------------------------------------------- yo'naltirish

  function parseRoute() {
    var hash = location.hash || '#/';
    return hash.replace(/^#/, '') || '/';
  }

  function dispatch() {
    if (!session.linked) { renderLink(); return; }

    var path = parseRoute();
    if (path === '/') return renderDashboard();
    if (path === '/payments') return renderPayments();
    if (path === '/profile') return renderProfile();
    if (path === '/topup') return renderTopup();
    var m = path.match(/^\/pay\/(\d+)$/);
    if (m) return renderPay(m[1]);
    return renderDashboard();
  }

  async function boot() {
    renderLoading();
    try {
      await loadSession();
    } catch (e) {
      renderErrorScreen(e.message === 'http_401' ? "Sessiya tasdiqlanmadi. Ilovani Telegram ichida qaytadan oching." : "Ma'lumot yuklanmadi. Internet aloqasini tekshiring.");
      return;
    }
    dispatch();
  }

  window.addEventListener('hashchange', function () {
    if (!session) { boot(); return; }
    dispatch();
  });

  boot();
})();
