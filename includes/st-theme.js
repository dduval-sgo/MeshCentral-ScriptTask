/**
* @description ScriptTask theme sync: use the MeshCentral Modern UI's Bootstrap theme and light/dark mode in plugin pages.
* Load this first, synchronously, in <head> so the page never paints with the wrong theme.
* @author Desmond Duval
* @license Apache-2.0
*/

"use strict";

(function () {
    var root = document.documentElement;
    var host = null;
    try { if (window.parent !== window && window.parent.document) host = window.parent; } catch (e) { host = null; }

    var link = document.createElement('link');
    link.id = 'theme-stylesheet';
    link.rel = 'stylesheet';
    document.head.appendChild(link);

    function hostThemeLink() { return host ? host.document.getElementById('theme-stylesheet') : null; }

    function standaloneMode() {
        // Same inputs as MeshCentral's setNightMode(): 1 = dark, 2 = light, 0 = follow the browser
        var n = '0';
        try { n = localStorage.getItem('nightMode') || '0'; } catch (e) { }
        if (n == '1') return 'dark';
        if (n == '2') return 'light';
        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    function standaloneHref() {
        var t = 'default';
        try { t = localStorage.getItem('theme') || 'default'; } catch (e) { }
        if (!/^[a-z0-9_-]+$/i.test(t) || t == 'default') return 'styles/bootstrap-min.css';
        return 'styles/themes/' + encodeURIComponent(t.toLowerCase()) + '/bootstrap-min.css';
    }

    function apply() {
        var href, mode;
        var hl = hostThemeLink();
        if (host && hl) {
            href = hl.href; // Absolute URL, so it works whatever the domain path is
            mode = host.document.documentElement.getAttribute('data-bs-theme') || 'light';
            root.removeAttribute('data-st-classic');
        } else if (host) {
            // Classic UI: it has no Bootstrap theme. Pages show a notice asking the user to switch to the Modern UI.
            href = 'styles/bootstrap-min.css';
            mode = (host.document.body && host.document.body.classList.contains('night')) ? 'dark' : 'light';
            root.setAttribute('data-st-classic', '1');
        } else {
            href = standaloneHref();
            mode = standaloneMode();
        }
        if (link.getAttribute('href') !== href) link.setAttribute('href', href);
        if (root.getAttribute('data-bs-theme') !== mode) root.setAttribute('data-bs-theme', mode);
    }

    apply();

    // Follow theme and mode changes made in MeshCentral while this page is open
    if (host) {
        var observer = new MutationObserver(apply);
        observer.observe(host.document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
        var hl = hostThemeLink();
        if (hl) observer.observe(hl, { attributes: true, attributeFilter: ['href'] });
        if (host.document.body) observer.observe(host.document.body, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('pagehide', function () { observer.disconnect(); });
    } else {
        window.addEventListener('storage', apply);
        if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
    }
})();
