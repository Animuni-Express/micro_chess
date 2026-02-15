// Supabase Edge Function: stockfish
// Standard version with explicit CORS and error handling

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
    // 1. Handle Preflight for CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        // 2. Parse Request
        const { fen } = await req.json()
        if (!fen) throw new Error('Missing FEN')

        console.log(`Analyzing FEN: ${fen}`)

        // 3. Get best move from Chess-API.com
        const response = await fetch('https://chess-api.com/v1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen, depth: 12 })
        })

        if (!response.ok) {
            throw new Error(`Chess API failed: ${response.statusText}`)
        }

        const data = await response.json()

        // 4. Return Result
        return new Response(
            JSON.stringify({ bestmove: data.move }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error(`Global error: ${errorMessage}`)
        return new Response(
            JSON.stringify({ error: errorMessage }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
    }
})
