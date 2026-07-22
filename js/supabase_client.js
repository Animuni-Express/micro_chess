/**
 * Supabase Client Configuration
 */

const SUPABASE_URL = 'https://ncsqidwsimmdbkoiidlz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jc3FpZHdzaW1tZGJrb2lpZGx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTM5MDEsImV4cCI6MjEwMDEyOTkwMX0.PB5aBxvZ2bqNLxGrehobWj48xZ1AzWBRPUjsO1-M7Ec';

// Note: The Supabase SDK is loaded via CDN in index.html
// This will initialize the client once the SDK is available
let supabaseInstance = null;

function getSupabase() {
    if (!supabaseInstance) {
        if (typeof supabase === 'undefined') {
            console.error('Supabase SDK not loaded. Ensure CDN script is included.');
            return null;
        }
        supabaseInstance = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log('Supabase Client Initialized');
    }
    return supabaseInstance;
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getSupabase };
} else {
    window.getSupabase = getSupabase;
}
