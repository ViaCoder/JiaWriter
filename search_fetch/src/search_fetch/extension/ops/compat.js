// Detection in the MAIN world: is an interactive verification present, and has it completed?
// Reads only; changes nothing. Branding- and language-independent signals: the platform's script
// and global markers, and the hidden input that a completed verification fills in.
(() => {
  const t = document.body ? document.body.innerText : "";
  const challengeIframe = !!document.querySelector(
    'iframe[src*="challenges.cloudflare"],iframe[src*="turnstile"],iframe[src*="captcha"],' +
    ".g-recaptcha,.h-captcha,#px-captcha,#challenge-running,#challenge-form");
  const cfChallenge = !!document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')
    || typeof window._cf_chl_opt !== "undefined"
    || !!document.querySelector('[id^="cf-chl"],.cf-turnstile,#cf-wrapper,#trk_jschal_js');
  const cfCleared = [...document.querySelectorAll('input[id^="cf-chl-widget"]')]
    .some((el) => el.value && el.value.length > 0);
  return JSON.stringify({ title: document.title || "", textLen: t.length, challengeIframe, cfChallenge, cfCleared });
})()
