const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf-8');
const urls = [...content.matchAll(/\"image\":\s*\"([^\"]+)\"/g)].map(m => m[1]);

async function checkUrls() {
    let output = '';
    for (const url of urls) {
        if(!url.includes('wikimedia.org')) continue;
        const proxyUrl = 'https://wsrv.nl/?url=' + encodeURIComponent(url);
        try {
            const res = await fetch(proxyUrl);
            if(!res.ok) {
                output += 'FAILED: ' + url + '\n';
            } else {
                output += 'OK: ' + url + '\n';
            }
        } catch (e) {
            output += 'ERROR: ' + url + ' - ' + e.message + '\n';
        }
    }
    fs.writeFileSync('fetch_results.txt', output);
}
checkUrls();
