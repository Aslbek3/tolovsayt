// Admin panel — mobil tortma menyu (sidebar drawer). Qurilish qadamisiz vanilla JS.
(function () {
  var burger = document.getElementById('admBurger');
  var sidebar = document.getElementById('admSidebar');
  var overlay = document.getElementById('admOverlay');
  if (!burger || !sidebar || !overlay) return;

  function openDrawer() {
    sidebar.classList.add('open');
    overlay.classList.add('show');
    burger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
    burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  burger.addEventListener('click', function () {
    if (sidebar.classList.contains('open')) closeDrawer(); else openDrawer();
  });
  overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawer();
  });
  // Tortmadagi havola yoki tugma bosilganda yopiladi
  var items = sidebar.querySelectorAll('a, button');
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener('click', closeDrawer);
  }
  // Ekran kengaytirilganda (desktop o'lchamiga o'tganda) tortma holatini tozalaymiz
  window.addEventListener('resize', function () {
    if (window.innerWidth >= 960) closeDrawer();
  });
})();
