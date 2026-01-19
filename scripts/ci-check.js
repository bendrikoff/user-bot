const fs = require('fs');
const path = require('path');

function checkFileExists(relPath) {
  const p = path.join(process.cwd(), relPath);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing file: ${relPath}`);
    process.exit(1);
  }
}

function checkPackageScript(name) {
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.scripts || !pkg.scripts[name]) {
    console.error(`❌ Missing npm script: ${name}`);
    process.exit(1);
  }
}

// Checks
checkFileExists('bot.js');
checkFileExists('package.json');
checkPackageScript('start');

console.log('✅ CI check passed');
