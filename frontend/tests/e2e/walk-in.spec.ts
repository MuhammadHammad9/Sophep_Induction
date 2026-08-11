import { test, expect } from '@playwright/test';

test.describe('Walk-in Registration Flow', () => {
  test('should allow a fast-track registration', async ({ page }) => {
    // Navigate to fast-track page (we will build this next)
    await page.goto('/fast-track');

    // Wait for the page to load
    await expect(page.locator('h1')).toContainText('Fast-Track');

    // Fill out the required details
    await page.fill('input[name="full_name"]', 'Test Walkin Applicant');
    await page.fill('input[name="email"]', `walkin-${Date.now()}@example.com`);
    await page.fill('input[name="phone"]', `03${String(Math.floor(Math.random() * 900000000 + 100000000))}`);

    // Submit the form
    await page.click('button[type="submit"]');

    // Expect to be checked in and redirected or see a success message
    await expect(page.locator('.success-message')).toBeVisible({ timeout: 10000 });
    
    // Optionally check that needs_completion is shown or check-in is confirmed
    await expect(page.locator('.success-message')).toContainText('Checked in');
  });
});
