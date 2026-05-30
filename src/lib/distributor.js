/**
 * Distribute recipients across accounts using round-robin
 * @param {Array} recipients - Array of recipient objects
 * @param {Array} accounts - Array of account objects
 * @returns {Array} - Array of { account, recipient } pairs
 */
export function distributeRoundRobin(recipients, accounts) {
  if (!accounts.length) throw new Error('No accounts connected');
  if (!recipients.length) throw new Error('No recipients provided');

  return recipients.map((recipient, index) => ({
    account: accounts[index % accounts.length],
    recipient,
    accountIndex: index % accounts.length,
  }));
}

/**
 * Replace template variables in text
 * Supports {{variable}} syntax
 * @param {string} template - Template string with {{variables}}
 * @param {object} data - Key-value pairs for replacement
 * @returns {string} - Processed string
 */
export function processTemplate(template, data) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = data[key] || data[key.toLowerCase()] || data[key.toUpperCase()];
    return value !== undefined ? value : match;
  });
}

/**
 * Parse CSV text into an array of objects
 * @param {string} csvText - Raw CSV text
 * @returns {Array<object>} - Array of row objects
 */
export function parseCSVSimple(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

  return lines.slice(1).map(line => {
    // Handle quoted values with commas
    const values = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = values[i] || '';
    });
    return obj;
  }).filter(row => {
    // Filter out empty rows
    const emailField = Object.keys(row).find(k => k.toLowerCase() === 'email');
    return emailField && row[emailField] && row[emailField].includes('@');
  });
}

/**
 * Add delay between operations
 * @param {number} ms - Milliseconds to wait
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
