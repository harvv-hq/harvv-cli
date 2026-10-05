#!/usr/bin/env node
/**
 * Harvv CLI — Install behavioral analytics in 30 seconds.
 *
 * Usage:
 *   npx @harvv/cli@latest              # Interactive setup
 *   npx @harvv/cli@latest --key abc123  # Install with existing pixel key
 *   npx @harvv/cli@latest issues        # View detected issues (needs API key)
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const https = require('https');

const API = 'https://harvv.com';
const PURPLE = '\x1b[35m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, data }); } });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function detectProject() {
  const cwd = process.cwd();
  const name = path.basename(cwd);

  // Check for package.json based projects
  if (fs.existsSync('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next']) return { type: 'nextjs', name: pkg.name || name };
      if (deps['gatsby']) return { type: 'gatsby', name: pkg.name || name };
      if (deps['nuxt']) return { type: 'nuxt', name: pkg.name || name };
      if (deps['@sveltejs/kit']) return { type: 'sveltekit', name: pkg.name || name };
      if (deps['react']) return { type: 'react', name: pkg.name || name };
      if (deps['vue']) return { type: 'vue', name: pkg.name || name };
      return { type: 'node', name: pkg.name || name };
    } catch {}
  }

  // Shopify theme detection — check multiple file patterns
  // Shopify themes have: layout/, templates/, sections/, snippets/, assets/, config/
  const shopifyMarkers = [
    'layout/theme.liquid',
    'templates/index.liquid',
    'templates/index.json',
    'config/settings_schema.json',
    'sections/header.liquid',
    'theme.liquid', // flat structure
  ];
  if (shopifyMarkers.some(f => fs.existsSync(f))) {
    return { type: 'shopify', name };
  }
  // Also check if we're inside a themes folder or have any .liquid files
  if (fs.existsSync('layout') && fs.existsSync('templates') && fs.existsSync('sections')) {
    return { type: 'shopify', name };
  }
  // Last resort: any .liquid files anywhere
  try {
    const files = fs.readdirSync(cwd);
    if (files.some(f => f.endsWith('.liquid'))) return { type: 'shopify', name };
    // Check one level deep for theme structure
    if (files.includes('layout') || files.includes('sections')) {
      try {
        const layoutDir = files.includes('layout') ? fs.readdirSync(path.join(cwd, 'layout')) : [];
        if (layoutDir.some(f => f.endsWith('.liquid'))) return { type: 'shopify', name };
      } catch {}
    }
  } catch {}

  // WordPress
  if (fs.existsSync('wp-content') || fs.existsSync('functions.php') || fs.existsSync('wp-config.php') || fs.existsSync('style.css') && fs.existsSync('header.php')) {
    return { type: 'wordpress', name };
  }

  // Static HTML
  if (fs.existsSync('index.html') || fs.existsSync('public/index.html')) {
    return { type: 'html', name };
  }

  return { type: 'unknown', name };
}

function findInstallFile(project) {
  // Find the right file to inject the pixel
  const checks = {
    nextjs: ['app/layout.tsx', 'app/layout.js', 'app/layout.jsx', 'pages/_document.tsx', 'pages/_document.js', 'pages/_app.tsx', 'pages/_app.js'],
    gatsby: ['src/html.js', 'gatsby-ssr.js'],
    react: ['public/index.html', 'index.html'],
    vue: ['public/index.html', 'index.html'],
    shopify: ['layout/theme.liquid', 'theme.liquid', 'snippets/harvv.liquid'],
    wordpress: ['functions.php', 'header.php', 'wp-content/themes/*/functions.php'],
    html: ['index.html', 'public/index.html'],
    sveltekit: ['src/app.html'],
    nuxt: ['nuxt.config.ts', 'nuxt.config.js', 'app.vue'],
  };
  for (const f of (checks[project.type] || checks.html)) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function getSnippet(key, project) {
  const tag = `<script src="https://harvv.com/px/${key}/pixel.js" async></script>`;
  if (project.type === 'nextjs') {
    return { code: `import Script from 'next/script'\n\n// Add inside your layout component:\n<Script src="https://harvv.com/px/${key}/pixel.js" strategy="afterInteractive" />`, htmlFallback: tag };
  }
  if (project.type === 'wordpress') {
    return { code: `// Add to functions.php:\nfunction harvv_pixel() {\n  echo '${tag}';\n}\nadd_action('wp_head', 'harvv_pixel');`, htmlFallback: tag };
  }
  if (project.type === 'shopify') {
    return { code: `{# Add before </head> in layout/theme.liquid #}\n${tag}`, htmlFallback: tag };
  }
  return { code: tag, htmlFallback: tag };
}

function injectPixel(file, key, project) {
  let content = fs.readFileSync(file, 'utf8');
  const tag = `<script src="https://harvv.com/px/${key}/pixel.js" async></script>`;

  // Don't inject twice
  if (content.includes('harvv.com/px/') || content.includes('pixel.js')) {
    return { success: false, reason: 'Pixel already installed in ' + file };
  }

  if (file.endsWith('.html') || file.endsWith('.liquid')) {
    // Inject before </head>
    if (content.includes('</head>')) {
      content = content.replace('</head>', `${tag}\n</head>`);
    } else if (content.includes('</body>')) {
      content = content.replace('</body>', `${tag}\n</body>`);
    } else {
      return { success: false, reason: 'Could not find </head> or </body> in ' + file };
    }
  } else if (file.endsWith('.tsx') || file.endsWith('.jsx') || file.endsWith('.js')) {
    // For Next.js/React — add a comment with instructions instead of auto-injecting JSX
    return { success: false, reason: 'manual', file, snippet: getSnippet(key, project) };
  } else if (file.endsWith('.php')) {
    // WordPress — append to functions.php
    content += `\n\n// Harvv behavioral analytics pixel\nfunction harvv_pixel() {\n  echo '${tag}';\n}\nadd_action('wp_head', 'harvv_pixel');\n`;
  } else {
    return { success: false, reason: 'Unsupported file type: ' + file };
  }

  fs.writeFileSync(file, content);
  return { success: true, file };
}

async function handleInstall(args) {
  console.log(`\n${PURPLE}${BOLD}  Harvv${RESET} ${DIM}— Behavioral analytics in 30 seconds${RESET}\n`);

  // Detect project
  const project = detectProject();
  console.log(`  ${DIM}Project:${RESET} ${project.name} ${DIM}(${project.type})${RESET}`);

  // Get pixel key
  let key = args.find(a => a.startsWith('--key='))?.split('=')[1] || args[args.indexOf('--key') + 1];

  if (!key) {
    console.log(`\n  ${BOLD}Let's set up Harvv on this project.${RESET}\n`);

    const hasAccount = await ask(`  ${DIM}Do you have a Harvv account? (y/n):${RESET} `);

    if (hasAccount.toLowerCase() === 'n' || hasAccount.toLowerCase() === 'no') {
      const email = await ask(`  ${DIM}Enter your email to create a free account:${RESET} `);
      if (!email || !email.includes('@')) { console.log(`\n  ${RED}Invalid email.${RESET}\n`); process.exit(1); }

      const domain = await ask(`  ${DIM}Your website domain (e.g., mysite.com):${RESET} `);

      console.log(`\n  ${DIM}Creating your account...${RESET}`);
      const res = await fetch(`${API}/v1/register`, {
        method: 'POST',
        body: JSON.stringify({ email, domain: domain || project.name, project_type: project.type }),
      });

      if (res.status === 200 || res.status === 201) {
        key = res.data.pixel_key;
        console.log(`  ${GREEN}Account created!${RESET}`);
        console.log(`  ${DIM}Pixel key:${RESET} ${BOLD}${key}${RESET}`);
        console.log(`  ${DIM}Check your email for login link.${RESET}\n`);
      } else {
        console.log(`  ${RED}${res.data?.error || 'Registration failed'}${RESET}`);
        console.log(`  ${DIM}Sign up at ${PURPLE}https://harvv.com${RESET} ${DIM}and run again with --key=YOUR_KEY${RESET}\n`);
        process.exit(1);
      }
    } else {
      key = await ask(`  ${DIM}Enter your pixel key (from Settings > Copy Snippet):${RESET} `);
      if (!key) { console.log(`\n  ${RED}No key provided.${RESET} Find it at https://harvv.com/site.html#/app\n`); process.exit(1); }
    }
  }

  // Find target file
  const targetFile = findInstallFile(project);
  const snippet = getSnippet(key, project);
  let installed = false;

  if (!targetFile) {
    console.log(`\n  ${YELLOW}${BOLD}Could not auto-install the pixel.${RESET}`);
    console.log(`  ${DIM}We couldn't find the right file to inject the script into.${RESET}\n`);
    console.log(`  ${BOLD}Manual install:${RESET} add this to your site's ${BOLD}<head>${RESET} section:\n`);
    console.log(`  ${GREEN}${snippet.htmlFallback}${RESET}\n`);
    if (project.type === 'shopify') {
      console.log(`  ${DIM}For Shopify: go to Online Store > Themes > Edit Code >${RESET}`);
      console.log(`  ${DIM}open ${BOLD}layout/theme.liquid${RESET}${DIM} and paste the script before ${BOLD}</head>${RESET}${DIM}.${RESET}\n`);
    }
  } else {
    console.log(`  ${DIM}Installing in:${RESET} ${targetFile}`);
    const result = injectPixel(targetFile, key, project);

    if (result.success) {
      console.log(`\n  ${GREEN}${BOLD}✓ Pixel installed!${RESET} ${GREEN}Added to ${result.file}${RESET}\n`);
      installed = true;
    } else if (result.reason === 'manual') {
      console.log(`\n  ${YELLOW}${BOLD}Manual install required for ${result.file}${RESET}`);
      console.log(`  ${DIM}Add this to your project:${RESET}\n`);
      console.log(`  ${GREEN}${result.snippet.code}${RESET}\n`);
      console.log(`  ${DIM}Or add to your HTML ${BOLD}<head>${RESET}${DIM}:${RESET}`);
      console.log(`  ${GREEN}${result.snippet.htmlFallback}${RESET}\n`);
    } else {
      const isAlreadyInstalled = result.reason.includes('already');
      console.log(`  ${isAlreadyInstalled ? GREEN : YELLOW}${result.reason}${RESET}\n`);
      if (isAlreadyInstalled) installed = true;
      if (!isAlreadyInstalled) {
        console.log(`  ${BOLD}Manual install:${RESET} add this to your site's ${BOLD}<head>${RESET}:\n`);
        console.log(`  ${GREEN}${snippet.htmlFallback}${RESET}\n`);
      }
    }
  }

  console.log(`  ${BOLD}What happens next:${RESET}`);
  if (installed) {
    console.log(`  ${DIM}1.${RESET} Deploy your site — the pixel starts capturing automatically`);
    console.log(`  ${DIM}2.${RESET} Check your email to set your password and log in`);
    console.log(`  ${DIM}3.${RESET} After 50+ sessions, issues are detected by AI`);
    console.log(`  ${DIM}4.${RESET} View your dashboard at ${PURPLE}https://harvv.com/site.html#/app${RESET}`);
  } else {
    console.log(`  ${DIM}1.${RESET} Check your email — we sent you a login link and install instructions`);
    console.log(`  ${DIM}2.${RESET} Paste the script above into your site's ${BOLD}<head>${RESET} section`);
    console.log(`  ${DIM}3.${RESET} Deploy your site to start capturing data`);
    console.log(`  ${DIM}4.${RESET} Log in at ${PURPLE}https://harvv.com/site.html#/app${RESET} ${DIM}to see your dashboard${RESET}`);
  }

  // Subdomain hint — prompt to install on subdomains too
  console.log(`\n  ${BOLD}${YELLOW}📡 Got subdomains?${RESET}`);
  console.log(`  ${DIM}If your site has subdomains (app.yoursite.com, shop.yoursite.com, etc.),${RESET}`);
  console.log(`  ${DIM}install the pixel on each one for the full picture.${RESET}`);
  console.log(`  ${DIM}Your dashboard will auto-detect live subdomains and show you which${RESET}`);
  console.log(`  ${DIM}ones still need the pixel — with one-click install instructions.${RESET}`);
  console.log(`  ${DIM}View at: ${PURPLE}https://harvv.com/site.html#/app${RESET}${DIM} → select your site → Overview${RESET}`);

  console.log(`\n  ${DIM}Run ${BOLD}npx @harvv/cli issues${RESET}${DIM} to check for detected UX issues.${RESET}\n`);
}

async function handleIssues(args) {
  const apiKey = process.env.HARVV_API_KEY || args.find(a => a.startsWith('--api-key='))?.split('=')[1];
  if (!apiKey) {
    console.log(`\n  ${YELLOW}No API key found.${RESET}`);
    console.log(`  ${DIM}Set HARVV_API_KEY environment variable or pass --api-key=hv_live_xxx${RESET}`);
    console.log(`  ${DIM}Create one at ${PURPLE}https://harvv.com/site.html#/app${RESET} ${DIM}→ Settings → API Keys${RESET}\n`);
    process.exit(1);
  }

  console.log(`\n${PURPLE}${BOLD}  Harvv${RESET} ${DIM}— Fetching issues...${RESET}\n`);

  const sitesRes = await fetch(`${API}/v1/sites`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (sitesRes.status !== 200) { console.log(`  ${RED}Auth failed. Check your API key.${RESET}\n`); process.exit(1); }

  const sites = sitesRes.data.sites || [];
  if (!sites.length) { console.log(`  ${YELLOW}No sites found.${RESET} Add a site at https://harvv.com/site.html#/app\n`); process.exit(1); }

  for (const site of sites) {
    const issuesRes = await fetch(`${API}/v1/sites/${site.id}/issues`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const issues = issuesRes.data?.issues || [];

    console.log(`  ${BOLD}${site.name}${RESET} ${DIM}(${site.domain})${RESET} — ${issues.length} issue${issues.length !== 1 ? 's' : ''}`);

    if (!issues.length) {
      console.log(`  ${DIM}No issues detected yet. Need 50+ sessions for detection.${RESET}\n`);
      continue;
    }

    for (const issue of issues.slice(0, 10)) {
      const title = (issue.description || issue.element || '').split('.')[0];
      const affected = parseInt(issue.sessions_affected) || 0;
      const statusColor = { open: RED, quoted: YELLOW, approved: GREEN, fixing: PURPLE }[issue.status] || DIM;
      console.log(`  ${DIM}#${issue.id}${RESET} ${statusColor}[${issue.status}]${RESET} ${title}`);
      console.log(`     ${DIM}${affected} visitors affected${RESET}`);
      if (issue.fix_suggestion) console.log(`     ${GREEN}Fix: ${issue.fix_suggestion.substring(0, 100)}...${RESET}`);
    }

    console.log(`\n  ${DIM}Full dashboard:${RESET} ${PURPLE}${issuesRes.data.dashboard_url}${RESET}\n`);
  }
}

// ─── Main ───
const args = process.argv.slice(2);
const command = args[0];

if (command === 'issues' || command === 'check') {
  handleIssues(args.slice(1)).catch(e => { console.error(`  ${RED}Error: ${e.message}${RESET}`); process.exit(1); });
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
${PURPLE}${BOLD}  Harvv CLI${RESET} — Behavioral UX Analytics

  ${BOLD}Usage:${RESET}
    npx @harvv/cli@latest              Install pixel (interactive)
    npx @harvv/cli@latest --key=xxx    Install with existing key
    npx @harvv/cli@latest issues       View detected UX issues
    npx @harvv/cli@latest help         Show this help

  ${BOLD}Environment:${RESET}
    HARVV_API_KEY                 API key for issues/stats commands

  ${BOLD}Links:${RESET}
    Dashboard   ${PURPLE}https://harvv.com/site.html#/app${RESET}
    API Docs    ${PURPLE}https://harvv.com/docs/api${RESET}
    Plugin      ${PURPLE}/plugin install github:harvv/claude-plugin${RESET}
`);
} else {
  handleInstall(args).catch(e => { console.error(`  ${RED}Error: ${e.message}${RESET}`); process.exit(1); });
}
