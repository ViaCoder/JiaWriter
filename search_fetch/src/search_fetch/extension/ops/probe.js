// search_fetch bridge page script (fetch-loop challenge probe). Runs via chrome.scripting.executeScript; the value of the
// last expression is returned to the sf process. Runs in the MAIN world (reads window._cf_chl_opt). From browser.py _PROBE_JS.
(() => {
  const t = document.body ? document.body.innerText : '';
  const challengeIframe = !!document.querySelector(
    'iframe[src*="challenges.cloudflare"],iframe[src*="turnstile"],iframe[src*="captcha"],' +
    '.g-recaptcha,.h-captcha,#px-captcha,#challenge-running,#challenge-form');
  // Branding- and language-INDEPENDENT Cloudflare signal. A managed/customised challenge
  // renders inline with the site's own wording and often no recognisable iframe, so both
  // the selector above and the phrase list miss it — the page is then judged 'blank',
  // gets the short budget and is closed within seconds, with no time for the check to
  // clear or for a human to click. Every CF challenge variant loads the challenge-platform
  // script and sets _cf_chl_opt, whatever it looks like.
  const cfChallenge = !!document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')
    || typeof window._cf_chl_opt !== 'undefined'
    || !!document.querySelector('[id^="cf-chl"],.cf-turnstile,#cf-wrapper,#trk_jschal_js');
  const cfCleared = [...document.querySelectorAll('input[id^="cf-chl-widget"]')]
    .some(el => el.value && el.value.length > 0);
  return JSON.stringify({ title: document.title || '', textLen: t.length,
    excerpt: t.replace(/\s+/g, ' ').trim().slice(0, 800), challengeIframe, cfChallenge, cfCleared });
})()
