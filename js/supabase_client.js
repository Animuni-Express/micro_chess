/**
 * Supabase Client Configuration
 */

const SUPABASE_URL = 'https://iupbboutzhnyqfwfnajf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1cGJib3V0emhueXFmd2ZuYWpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzNzE3NjAsImV4cCI6MjA4NTk0Nzc2MH0.r9JZhTAknT6uOtSJeXLkaMeQwl_bZ0otUy3o9WmEiZ8';

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
