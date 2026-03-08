const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    page.on('console', msg => {
        console.log('BROWSER LOG:', msg.text());
    });
    
    page.on('pageerror', error => {
        console.log('BROWSER ERROR:', error.message);
    });
    
    page.on('requestfailed', request => {
        console.log('BROWSER REQUEST FAILED:', request.url(), request.failure().errorText);
    });

    await page.goto('http://localhost:8080');
    
    // wait for a bit
    await new Promise(r => setTimeout(r, 5000));
    
    await browser.close();
})();
