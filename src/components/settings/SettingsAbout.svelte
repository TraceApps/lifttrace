<script>
  /**
   * About section of Settings. Purely informational — no state, no mutations.
   * Receives the expanded flag + a toggle callback and a section-visibility
   * check from the parent so it slots into the existing collapsible layout.
   */
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { APP_VERSION } from '../../lib/version.js';
  import { resolveAssetUrl, iconUrl, isNative } from '../../lib/platform.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">info</span></span>
    <span class="section-name">{$_('settings.about.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <div class="about-hero">
          <img src={iconUrl('/icons/icon-192.png')} alt="LiftTrace" class="about-icon" />
          <div>
            <div class="about-name">{$_('settings_about.app_name')}</div>
            <div class="about-version">
              v{APP_VERSION}
              <span class="platform-tag">{isNative ? 'Android' : 'PWA'}</span>
            </div>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="about-desc">
          Track Every Rep — Personal Weightlifting Tracker. LiftTrace is a self-hosted
          workout tracker built for privacy. Your data lives on your server, not in the cloud.
          Features workout diary, program builder, multi-source exercise library, AI coaching,
          statistics, and more.
        </div>
        <div class="setting-divider"></div>
        <div class="about-row">
          <span class="material-symbols-rounded about-feat-icon">database</span>
          <span>Self-hosted — your data, your server</span>
        </div>
        <div class="setting-divider"></div>
        <div class="about-row">
          <span class="material-symbols-rounded about-feat-icon">install_mobile</span>
          <span>PWA — installable on any device</span>
        </div>
        <div class="setting-divider"></div>
        <div class="about-row">
          <span class="material-symbols-rounded about-feat-icon">lock</span>
          <span>No tracking, no ads, no third-party analytics</span>
        </div>
        <div class="setting-divider"></div>
        <div class="about-row">
          <span class="material-symbols-rounded about-feat-icon">code</span>
          <span><a href="https://github.com/TraceApps/lifttrace" target="_blank" rel="noopener" class="about-link">{$_('settings_about.open_source')}</a> (AGPL-3.0)</span>
        </div>
        <div class="setting-divider"></div>
        <div class="about-row">
          <span class="material-symbols-rounded about-feat-icon">link</span>
          <span>{$_('settings_about.sister_app_prefix')}<a href="https://github.com/TraceApps/nutritrace" target="_blank" rel="noopener" class="about-link">NutriTrace</a>{$_('settings_about.sister_app_suffix')}</span>
        </div>
        <div class="setting-divider"></div>
        <div class="about-row" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="material-symbols-rounded about-feat-icon">volunteer_activism</span>
            <span>{$_('settings_about.support_development')}</span>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;padding-left:30px">
            <!-- GitHub Sponsors button hidden until the traceapps org Sponsors profile is approved.
                 Re-enable by uncommenting the <a> below (and the github: line in .github/FUNDING.yml).
            <a href="https://github.com/sponsors/traceapps" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
              <span class="material-symbols-rounded" style="font-size:14px">favorite</span> GitHub Sponsors
            </a>
            -->
            <a href="https://ko-fi.com/traceapps" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
              <span class="material-symbols-rounded" style="font-size:14px">coffee</span> Ko-fi
            </a>
          </div>
          <div class="setting-desc" style="padding-left:30px;font-size:11px">LiftTrace is free to self-host. Donations are appreciated but never required.</div>
        </div>
        <div class="setting-divider"></div>
        <div class="about-desc" style="font-size:11px;color:var(--text-3);line-height:1.5">
          <strong>Disclaimer.</strong> LiftTrace is not medical, health, or fitness-professional
          software. It does not provide medical advice, diagnosis, treatment, or personalized
          training prescriptions. Exercise library content, Trace AI coaching, program templates,
          rest-timer guidance, and any analytical output (volume, PRs, frequency, body-weight
          trends) are for informational and self-tracking purposes only.
          <br /><br />
          Resistance training carries inherent risk of injury. Exercise selection, load, technique,
          and progression can interact with medical conditions (heart and cardiovascular conditions,
          high blood pressure, prior surgery, hernias, joint or spinal issues, osteoporosis,
          pregnancy, connective-tissue disorders, recent injury or rehabilitation status) in ways
          this app cannot assess. Consult a qualified healthcare professional, certified strength
          coach, or licensed physical therapist before starting a new training program, returning
          from injury, or making significant changes to your routine.
          <br /><br />
          Trace AI answers can be incorrect or incomplete; treat them as a starting point, not a
          substitute for human judgment or professional advice. Exercise library data is sourced
          from public databases (wger, Free Exercise DB, optionally ExerciseDB via RapidAPI) and
          may contain inaccuracies. Use at your own risk.
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Section-specific styles \u2014 the shared framework classes
     (.section-toggle, .section-body, .card, .setting-divider, etc.)
     live in Settings.svelte's :global() block. */
  .about-hero { display: flex; align-items: center; gap: 16px; padding: 16px; }
  .about-icon { width: 56px; height: 56px; border-radius: 12px; }
  .about-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .about-version {
    margin-top: 2px; font-size: 13px; color: var(--text-3);
    display: inline-flex; align-items: center; gap: 8px;
  }
  /* Small accent pill telling the user which build they're running.
     Mirrors NutriTrace's about-card platform tag for brand cohesion. */
  .platform-tag {
    font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent); background: var(--accent-dim);
    padding: 2px 8px;
    border-radius: var(--radius-full, 999px);
  }
  .about-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; padding: 12px 16px; }
  .about-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; font-size: 14px; color: var(--text-1); }
  .about-feat-icon { font-size: 20px; color: var(--accent); flex-shrink: 0; }
  .about-link { color: var(--accent); text-decoration: underline; }
  .about-link:hover { opacity: 0.8; }
</style>
