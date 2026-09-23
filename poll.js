const https = require('https');

function check() {
  https.get('https://arthurvault-backend-production.up.railway.app/health', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        console.log(JSON.stringify(json));
        if (json.runtime && json.runtime.puppeteer_executable !== 'NOT_SET') {
          process.exit(0);
        } else if (json.build !== 'build-docker-fix-v2') {
           // still building
        }
      } catch(e) {}
    });
  }).on('error', () => {});
}

setInterval(check, 5000);
check();
