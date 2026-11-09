(() => {
    const nav = document.createElement('nav');
    nav.className = 'page-nav';
    nav.setAttribute('aria-label', '페이지 이동');

    const home = document.createElement('a');
    home.href = 'Subject.html';
    home.textContent = '처음으로';

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.textContent = '로그아웃';
    logout.addEventListener('click', async () => {
        logout.disabled = true;
        try {
            const response = await fetch('/api/logout', { method: 'POST' });
            if (!response.ok) throw new Error('로그아웃 실패');
            window.location.assign('sign_up.html');
        } catch {
            logout.disabled = false;
            alert('로그아웃하지 못했습니다. 다시 시도해 주세요.');
        }
    });

    nav.append(home, logout);
    document.body.append(nav);

    function placeBesideContent() {
        const panel = document.querySelector('.content');
        if (!panel) return;

        const panelRect = panel.getBoundingClientRect();
        const navWidth = nav.offsetWidth;
        const navHeight = nav.offsetHeight;
        const gap = 20;
        const pageLeft = panelRect.left + window.scrollX;
        const pageRight = panelRect.right + window.scrollX;
        const pageBottom = panelRect.bottom + window.scrollY;
        let left;
        let top;

        if (panelRect.right + gap + navWidth <= window.innerWidth) {
            left = pageRight + gap;
            top = pageBottom - navHeight;
        } else if (panelRect.left >= gap + navWidth) {
            left = pageLeft - navWidth - gap;
            top = pageBottom - navHeight;
        } else {
            left = Math.max(12, Math.min(pageRight - navWidth, window.innerWidth - navWidth - 12) + window.scrollX);
            top = pageBottom + 12;
        }

        nav.style.left = `${left}px`;
        nav.style.top = `${top}px`;
    }

    placeBesideContent();
    window.addEventListener('resize', placeBesideContent);
    window.addEventListener('load', placeBesideContent, { once: true });
    if ('ResizeObserver' in window) {
        new ResizeObserver(placeBesideContent).observe(document.querySelector('.content'));
    }
})();
