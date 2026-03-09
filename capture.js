const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto('https://zirkeldep.com/shape/simulador-comparador-a246.html', { waitUntil: 'networkidle2' });
    
    // Zoom in or crop to a nice section if necessary, but a full screenshot is fine.
    await page.screenshot({ path: 'simulador.png' });
    await browser.close();
    console.log('Screenshot saved to simulador.png');
})();
