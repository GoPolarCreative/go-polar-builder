import type { BuildFacts, ContentPlan } from '../../../shared/plan.js'
import { styleSpec } from '../../../shared/styles.js'
import {
  ICON_CHEVRON,
  ICON_CLOCK,
  ICON_MAIL,
  ICON_MENU,
  ICON_PHONE,
  ICON_PIN,
  ICON_SHIELD,
  ICON_TICK,
  brandMarkup,
  clean,
  esc,
  formMarkup,
  icon,
  picture,
  resolveSurfaces,
  sectionHead,
  stylesheet,
  twoTone,
} from './site.js'
import {
  breadcrumbSchema,
  canonicalFor,
  relativeLink,
  serviceSchema,
  type SitePage,
} from '../pages.js'

/**
 * A dedicated service page.
 *
 * Rendered from the SAME stylesheet function, the same cards, the same form and the same section
 * heads as the home page. That is deliberate and it is the whole point: a page set has to be
 * unmistakably one site, so there is exactly one design system and no parallel copy of it that can
 * drift.
 *
 * WHAT MAKES IT WORTH BUYING, stated as a mechanism rather than a promise: a home page covering
 * eight services competes with itself for every one of them. A page about one service, in a named
 * service area, gives a search engine something specific to match. That is why the h1, the meta
 * description, the intro copy and the areas section on this page are all about one service.
 */
export function renderServicePage(args: {
  plan: ContentPlan
  facts: BuildFacts
  page: SitePage
  pages: SitePage[]
  baseUrl: string
}): string {
  const { plan, facts, page, pages, baseUrl } = args
  const spec = styleSpec(plan.style.resolved)
  const surfaces = resolveSurfaces(plan, spec)
  const content = plan.servicePages.find((p) => p.slug === page.slug)
  if (!content) throw new Error(`No plan content for service page ${page.slug}`)

  const home = pages[0]!
  const photo = facts.photos[0] ?? null
  const aboutPhoto = facts.photos[1] ?? photo

  // Relative, so the same file works served and opened from a discharge zip on someone's desktop.
  const linkTo = (target: SitePage) => relativeLink(page, target)

  const navItems = [
    { href: linkTo(home), label: 'Home' },
    ...pages.slice(1).map((p) => ({ href: linkTo(p), label: p.service ?? 'Service' })),
    { href: `${linkTo(home)}#contact`, label: 'Contact' },
  ]

  const graph = [
    breadcrumbSchema(baseUrl, page),
    serviceSchema(baseUrl, page, plan, facts),
  ].filter(Boolean)

  const background = photo
    ? picture({
        webp: `../../${photo.webWebp}`,
        jpeg: `../../${photo.webJpeg}`,
        alt: clean(`${content.service} by ${plan.brand.businessName} in ${plan.meta.geoPlacename}`),
        width: photo.width,
        height: photo.height,
        eager: true,
        sizes: '100vw',
      })
    : '<!-- CLIENT TO SUPPLY: a photo of this service being carried out. -->'

  const trustPoints = plan.hero.trustPoints
    .map((p) => `<li>${icon(ICON_TICK)}<span>${esc(clean(p))}</span></li>`)
    .join('\n        ')

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(clean(content.title))}</title>
<meta name="description" content="${esc(clean(content.metaDescription))}">
<link rel="canonical" href="${esc(canonicalFor(baseUrl, page))}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(clean(content.title))}">
<meta property="og:description" content="${esc(clean(content.metaDescription))}">
<meta property="og:url" content="${esc(canonicalFor(baseUrl, page))}">
<meta property="og:locale" content="en_AU">
<meta name="twitter:card" content="summary_large_image">
<meta name="geo.region" content="${esc(plan.meta.geoRegion)}">
<meta name="geo.placename" content="${esc(plan.meta.geoPlacename)}">
<meta name="theme-color" content="${plan.tokens.primary}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${spec.fontsQuery}&display=swap">
<script type="application/ld+json">
${JSON.stringify(graph.length === 1 ? graph[0] : graph, null, 2)}
</script>
<style>
${stylesheet(plan, spec, surfaces)}
</style>
</head>
<body>
<header class="site-header" id="siteHeader">
  <div class="wrap site-header__inner">
    ${brandMarkup(plan, facts).replace(/href="#top"/, `href="${linkTo(home)}"`)}
    <nav class="nav" aria-label="Main">
      ${navItems.map((n) => `<a href="${esc(n.href)}">${esc(n.label)}</a>`).join('\n      ')}
    </nav>
    <a class="btn btn--primary header__cta" href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(facts.phoneDisplay)}</a>
    <button class="menu-toggle" id="menuToggle" aria-expanded="false" aria-controls="mobilePanel" aria-label="Open menu">${icon(ICON_MENU)}</button>
  </div>
</header>
<div class="mobile-panel" id="mobilePanel" data-open="false">
  ${navItems.map((n) => `<a href="${esc(n.href)}">${esc(n.label)}</a>`).join('\n  ')}
  <a class="btn btn--primary btn--block" href="tel:${esc(facts.phoneE164)}">${esc(clean(plan.hero.ctaPrimary.label))}</a>
</div>

<section class="hero" id="top">
  <div class="hero__bg">
    ${background}
    <div class="hero__scrim"></div>
    <div class="hero__glow"></div>
  </div>
  <div class="wrap hero__inner">
    <div class="hero__copy">
      <span class="eyebrow">${esc(clean(content.service))}</span>
      <h1>${twoTone(content.h1, spec.twoTone)}</h1>
      <p class="hero__sub">${esc(clean(content.intro[0]!))}</p>
      <div class="hero__ctas">
        <a class="btn btn--primary" href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(facts.phoneDisplay)}</a>
        <a class="btn btn--ghost" href="#contact">${esc(clean(plan.hero.ctaSecondary.label))}</a>
      </div>
      <ul class="hero__points">
        ${trustPoints}
      </ul>
    </div>
    ${formMarkup({
      id: 'servicePageForm',
      heading: plan.hero.formHeading,
      button: plan.hero.formButtonLabel,
      subject: `${content.service} enquiry from ${plan.brand.businessName}`,
      key: facts.web3formsKey,
      headingLevel: 2,
      eyebrow: 'Start a conversation',
    })}
  </div>
</section>

<section class="trust-bar">
  <div class="wrap trust-grid">
    ${plan.trustStrip
      .map(
        (item, i) =>
          `<div class="trust-item">${icon([ICON_SHIELD, ICON_CLOCK, ICON_TICK, ICON_PIN][i % 4]!)}<div><b>${esc(clean(item.label))}</b><small>${esc(clean(item.detail))}</small></div></div>`,
      )
      .join('\n    ')}
  </div>
</section>

<section class="section" id="detail">
  <div class="wrap about-grid">
    <div class="about__copy">
      <span class="eyebrow">What it involves</span>
      <h2>${twoTone(`${content.service}, done properly`, spec.twoTone)}</h2>
      ${content.intro.map((para) => `<p>${esc(clean(para))}</p>`).join('\n      ')}
      <div class="about__actions">
        <a class="btn btn--primary" href="#contact">${esc(clean(plan.hero.ctaSecondary.label))}</a>
        <a class="btn btn--outline" href="${esc(linkTo(home))}#services">All our services</a>
      </div>
    </div>
    <div class="about__media">
      ${
        aboutPhoto
          ? picture({
              webp: `../../${aboutPhoto.webWebp}`,
              jpeg: `../../${aboutPhoto.webJpeg}`,
              alt: clean(`${plan.brand.businessName} at work in ${plan.meta.geoPlacename}`),
              width: aboutPhoto.width,
              height: aboutPhoto.height,
              sizes: '(min-width:900px) 50vw, 100vw',
            })
          : '<!-- CLIENT TO SUPPLY: a photo of this service being carried out. -->'
      }
    </div>
  </div>
</section>

<section class="section section--alt" id="included">
  <div class="wrap">
    ${sectionHead({
      eyebrow: 'What you get',
      heading: `What is included, on every job`,
      blurb: null,
      spec,
    })}
    <div class="grid grid--3">
      ${content.included
        .map(
          (line, i) => `<article class="card">
        <span class="card__num">${String(i + 1).padStart(2, '0')}</span>
        <p>${esc(clean(line))}</p>
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="section section--dark" id="areas">
  <div class="wrap">
    ${sectionHead({
      eyebrow: 'Where we work',
      heading: `${content.service} across ${plan.meta.geoPlacename}`,
      blurb: clean(plan.serviceAreas.blurb),
      spec,
      dark: true,
    })}
    <ul class="suburbs">
      ${plan.serviceAreas.suburbs.map((sub) => `<li>${esc(clean(sub))}</li>`).join('\n      ')}
    </ul>
  </div>
</section>

<section class="section" id="process">
  <div class="wrap">
    ${sectionHead({
      eyebrow: 'How it works',
      heading: 'A clear path, from first call to finished job',
      blurb: null,
      spec,
    })}
    <div class="process-grid">
      ${plan.process
        .map(
          (step, i) => `<div class="step">
        <span class="step__num">${String(i + 1).padStart(2, '0')}</span>
        <h3>${esc(clean(step.title))}</h3>
        <p>${esc(clean(step.body))}</p>
      </div>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="section section--alt" id="faq">
  <div class="wrap">
    ${sectionHead({ eyebrow: 'Common questions', heading: 'Questions, answered', blurb: null, spec })}
    <div class="faq">
      ${plan.faq
        .slice(0, 4)
        .map(
          (f, i) => `<div class="faq-item" data-faq data-open="${i === 0 ? 'true' : 'false'}">
        <button type="button" aria-expanded="${i === 0 ? 'true' : 'false'}">${esc(clean(f.q))}${icon(ICON_CHEVRON)}</button>
        <div class="faq-answer"><p>${esc(clean(f.a))}</p></div>
      </div>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="section cta-band">
  <div class="wrap">
    <span class="eyebrow">Get started</span>
    <h2>${twoTone(`Need ${content.service.toLowerCase()}? Give us a call.`, spec.twoTone)}</h2>
    <p>${esc(clean(plan.ctaBand.body))}</p>
    <div class="cta-band__actions">
      <a class="btn btn--primary" href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}${esc(facts.phoneDisplay)}</a>
      <a class="btn btn--ghost" href="#contact">${esc(clean(plan.ctaBand.ctaLabel))}</a>
    </div>
  </div>
</section>

<section class="section" id="contact">
  <div class="wrap contact-grid">
    <div>
      <span class="eyebrow">Get in touch</span>
      <h2>${twoTone(plan.contact.heading, spec.twoTone)}</h2>
      <p>${esc(clean(plan.contact.blurb))}</p>
      <ul class="contact-list">
        <li>${icon(ICON_PHONE)}<div><b>Phone</b><a href="tel:${esc(facts.phoneE164)}">${esc(facts.phoneDisplay)}</a></div></li>
        <li>${icon(ICON_MAIL)}<div><b>Email</b><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></div></li>
        <li>${icon(ICON_PIN)}<div><b>Based in</b><span>${esc(`${plan.meta.geoPlacename} and surrounding suburbs`)}</span></div></li>
      </ul>
      <h3>Opening hours</h3>
      <ul class="hours">
        ${facts.hoursLines.map((l) => `<li>${esc(l)}</li>`).join('\n        ')}
      </ul>
    </div>
    ${formMarkup({
      id: 'contactForm',
      heading: plan.contact.formHeading,
      button: plan.contact.formButtonLabel,
      subject: `${content.service} enquiry from ${plan.brand.businessName}`,
      key: facts.web3formsKey,
      headingLevel: 3,
      eyebrow: 'Send an enquiry',
    })}
  </div>
</section>

<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <p class="brand__name">${esc(plan.brand.wordmarkText)}</p>
        <p class="site-footer__blurb">${esc(clean(plan.brand.tagline))}</p>
      </div>
      <div>
        <h4>Services</h4>
        <ul>
          ${pages
            .slice(1)
            .map((sp) => `<li><a href="${esc(linkTo(sp))}">${esc(sp.service ?? '')}</a></li>`)
            .join('\n          ')}
          <li><a href="${esc(linkTo(home))}#services">All services</a></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <li><a href="${esc(linkTo(home))}">Home</a></li>
          <li><a href="${esc(linkTo(home))}#about">About</a></li>
          <li><a href="${esc(linkTo(home))}#areas">Areas</a></li>
        </ul>
      </div>
      <div>
        <h4>Contact</h4>
        <ul>
          <li><a href="tel:${esc(facts.phoneE164)}">${esc(facts.phoneDisplay)}</a></li>
          <li><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></li>
          <li>${esc(plan.meta.geoPlacename)}</li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; ${new Date().getUTCFullYear()} ${esc(plan.brand.businessName)}.${facts.abn ? ` ABN ${esc(facts.abn)}.` : ''}</span>
      <span><a href="https://www.itscold.com.au" target="_blank" rel="noopener">Website by Go Polar Creative</a></span>
    </div>
  </div>
</footer>

<div class="mobile-bar">
  <a href="tel:${esc(facts.phoneE164)}">${icon(ICON_PHONE)}Call now</a>
  <a href="#contact">${esc(clean(plan.hero.ctaSecondary.label))}</a>
</div>

<script>
(function(){
  var header=document.getElementById('siteHeader');
  var toggle=document.getElementById('menuToggle');
  var panel=document.getElementById('mobilePanel');
  if(header){
    var onScroll=function(){
      if(window.scrollY>60){header.classList.add('site-header--solid');}
      else{header.classList.remove('site-header--solid');}
    };
    onScroll();
    window.addEventListener('scroll',onScroll,{passive:true});
  }
  if(toggle&&panel){
    toggle.addEventListener('click',function(){
      var open=panel.getAttribute('data-open')==='true';
      panel.setAttribute('data-open',open?'false':'true');
      toggle.setAttribute('aria-expanded',open?'false':'true');
    });
  }
  Array.prototype.slice.call(document.querySelectorAll('[data-faq]')).forEach(function(item){
    var button=item.querySelector('button');
    if(!button){return;}
    button.addEventListener('click',function(){
      var open=item.getAttribute('data-open')==='true';
      item.setAttribute('data-open',open?'false':'true');
      button.setAttribute('aria-expanded',open?'false':'true');
    });
  });
  Array.prototype.slice.call(document.querySelectorAll('form[data-web3form]')).forEach(function(form){
    var status=form.querySelector('.form-status');
    var button=form.querySelector('button[type=submit]');
    form.addEventListener('submit',function(e){
      e.preventDefault();
      if(!status||!button){return;}
      var original=button.textContent;
      button.disabled=true;
      button.textContent='Sending';
      status.removeAttribute('data-state');
      status.textContent='';
      fetch('https://api.web3forms.com/submit',{
        method:'POST',
        headers:{'Accept':'application/json'},
        body:new FormData(form)
      }).then(function(res){return res.json();}).then(function(data){
        if(data&&data.success){
          form.innerHTML='<h3>Thanks, that has come through.</h3><p>We will be in touch shortly. If it is urgent, ring us instead.</p>';
        }else{
          throw new Error('submit failed');
        }
      }).catch(function(){
        status.setAttribute('data-state','error');
        status.textContent='That did not send. Please ring us instead and we will sort it.';
        button.disabled=false;
        button.textContent=original;
      });
    });
  });
})();
</script>
</body>
</html>`
}
