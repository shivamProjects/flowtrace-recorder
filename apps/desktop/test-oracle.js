const { chromium } = require('playwright');

(async () => {
    try {
        console.log("Starting backend recording session...");
        const startRes = await fetch('http://localhost:3000/api/record/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://ibqwjb-dev1.fa.ocs.oraclecloud.com' })
        });
        console.log(await startRes.json());
        
        await new Promise(r => setTimeout(r, 6000));
        
        console.log("Connecting to Playwright browser via CDP...");
        const browser = await chromium.connectOverCDP('http://localhost:9222');
        const contexts = browser.contexts();
        const page = contexts[0].pages()[0] || await contexts[0].newPage();

        console.log("Waiting for Oracle login page...");
        await page.goto('https://ibqwjb-dev1.fa.ocs.oraclecloud.com');
        await page.waitForLoadState('domcontentloaded');
        
        // Oracle Cloud often uses specific name attributes or IDs. We'll use a robust selector.
        const userField = page.locator('input[name="userid"], input[name="username"], input[id="userid"], input[type="email"]').first();
        await userField.waitFor({ state: 'visible', timeout: 45000 });
        console.log("Found username field, filling...");
        await userField.fill('mgrc-integration');

        const passField = page.locator('input[type="password"]').first();
        await passField.waitFor({ state: 'visible', timeout: 5000 });
        await passField.fill('ATOM#integrate1');

        console.log("Submitting login...");
        await page.keyboard.press('Enter');

        console.log("Waiting for dashboard to load (15 seconds)...");
        await page.waitForTimeout(15000); 

        await browser.close();

        console.log("Stopping backend recording session to trigger parser...");
        const stopRes = await fetch('http://localhost:3000/api/record/stop', { method: 'POST' });
        const data = await stopRes.json();
        
        console.log("\n--- PARSED ACTIONS ---");
        console.log(JSON.stringify(data.data.actions, null, 2));

    } catch (e) {
        console.error("Test failed:", e);
    }
})();
