/* Mijoz kabineti uchun kichik yordamchilar — kutubxonasiz, qurilish qadamisiz.
   Bu fayl bo'lmasa ham barcha sahifalar ishlaydi (progressive enhancement). */
(function () {
  'use strict';

  /* ------------------------------------------------------------- toast */

  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // majburiy reflow — ketma-ket chaqirilsa animatsiya qayta boshlanadi
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }
  window.toast = toast;

  function money(n) {
    return Number(n || 0).toLocaleString('ru-RU').replace(/ /g, ' ') + " so'm";
  }

  /* ------------------------------------------- karta raqamini nusxalash */

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Zaxira yo'l: WebView'da clipboard API bloklangan bo'lishi mumkin
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

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    var raw = (btn.getAttribute('data-copy') || '').replace(/\s+/g, '');
    copyText(raw).then(function () {
      toast('Karta raqami nusxalandi');
    }).catch(function () {
      toast("Nusxalanmadi — raqamni qo'lda yozib oling");
    });
  });

  /* ------------------------------------------------- oy / summa chiplari */

  function syncTotal(root) {
    var picked = root.querySelector('input[name="months"]:checked');
    if (!picked) return;
    var price = Number(root.getAttribute('data-price') || 0);
    var months = Number(picked.value || 1);
    var out = root.querySelector('[data-total]');
    if (out) out.textContent = money(price * months);
    var lbl = root.querySelector('[data-total-note]');
    if (lbl) lbl.textContent = months + ' oy uchun';
  }

  document.querySelectorAll('[data-price]').forEach(function (root) {
    root.addEventListener('change', function (e) {
      if (e.target.name === 'months') syncTotal(root);
    });
    syncTotal(root);
  });

  /* ------------------------------------------ summa maydonini formatlash */

  // Kiritilgan summaga mos tez-tanlash tugmasini belgilab qo'yadi
  function markAmountChips(digits) {
    document.querySelectorAll('[data-fill]').forEach(function (b) {
      b.classList.toggle('is-on', String(b.getAttribute('data-fill')) === digits);
    });
  }

  document.querySelectorAll('[data-amount]').forEach(function (inp) {
    function fmt() {
      var digits = inp.value.replace(/\D/g, '').slice(0, 12);
      inp.value = digits ? Number(digits).toLocaleString('ru-RU').replace(/ /g, ' ') : '';
      markAmountChips(digits);
    }
    inp.addEventListener('input', fmt);
    fmt();
  });

  // Tez tanlash tugmalari (50 000 / 100 000 ...)
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fill]');
    if (!b) return;
    e.preventDefault();
    var target = document.querySelector(b.getAttribute('data-fill-target') || '[data-amount]');
    if (!target) return;
    target.value = Number(b.getAttribute('data-fill')).toLocaleString('ru-RU').replace(/ /g, ' ');
    // Klaviaturani ataylab ochmaymiz — tayyor summa tanlangan
    target.dispatchEvent(new Event('input'));
  });

  /* --------------------------------------------- chek faylini ko'rsatish */

  document.querySelectorAll('.file-pick').forEach(function (pick) {
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

  /* ------------------------------------ ikki marta yuborishdan saqlanish */

  document.querySelectorAll('form[data-once]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      // inline onsubmit="return confirm(...)" bekor qilgan bo'lsa — tegmaymiz
      if (e.defaultPrevented) return;
      if (form.dataset.sent === '1') { e.preventDefault(); return; }
      form.dataset.sent = '1';
      var btn = form.querySelector('button[type="submit"], button:not([type])');
      if (!btn) return;
      var busyText = form.getAttribute('data-once') || 'Yuborilmoqda…';
      // Yuborish boshlangandan keyin o'chiramiz, aks holda forma jo'namaydi
      setTimeout(function () {
        btn.classList.add('is-busy');
        btn.disabled = true;
        btn.textContent = busyText;
      }, 0);
    });
  });
})();
