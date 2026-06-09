// api/paper-cron.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    try {
        const supabase = createClient(
            process.env.SUPABASE_URL || '',
            process.env.SUPABASE_SERVICE_ROLE_KEY || ''
        );

        // Fetch all active simulation entries
        const { data: openTrades, error } = await supabase
            .from('demo_trades')
            .select('*')
            .eq('status', 'OPEN');

        if (error || !openTrades || openTrades.length === 0) {
            return res.status(200).json({ message: 'No active simulation tracking metrics.' });
        }

        const solToUsdRate = 180.00;

        for (const trade of openTrades) {
            // 1. Fetch the absolute newest execution pricing matrix via GeckoTerminal
            const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${trade.token_address}/pools?page=1`);
            const json = await response.json();
            if (!json.data || json.data.length === 0) continue;

            const currentPrice = parseFloat(json.data[0].attributes.base_token_price_usd || '0');
            if (currentPrice === 0) continue;

            // Calculate exact performance delta vectors
            const priceChangePct = ((currentPrice - trade.entry_price_usd) / trade.entry_price_usd) * 100;
            const hoursElapsed = (Date.now() - new Date(trade.entered_at).getTime()) / (1000 * 60 * 60);

            let statusUpdate = 'OPEN';
            if (priceChangePct >= 50.0) statusUpdate = 'WIN';          // Take-Profit Target Breach
            if (priceChangePct <= -15.0) statusUpdate = 'LOSS';        // Stop-Loss Protection Breached
            if (hoursElapsed >= 4.0 && statusUpdate === 'OPEN') statusUpdate = 'PURGED'; // Stagnant Momentum Time Purge

            if (statusUpdate !== 'OPEN') {
                // Apply a 1.5% slippage penalty on trade exit execution
                const simulatedExitPrice = currentPrice * 0.985;
                const realizedUsdValue = trade.tokens_acquired * simulatedExitPrice;
                const realizedSolValue = realizedUsdValue / solToUsdRate;
                const netSolPnL = realizedSolValue - parseFloat(trade.allocated_sol);

                // Re-credit the virtual portfolio pool balance
                const { data: balData } = await supabase.from('user_demo_balances').select('virtual_sol_balance').eq('tg_user_id', trade.tg_user_id).single();
                if (balData) {
                    const restoredBalance = parseFloat(balData.virtual_sol_balance) + realizedSolValue;
                    await supabase.from('user_demo_balances').update({ virtual_sol_balance: restoredBalance }).eq('tg_user_id', trade.tg_user_id);
                }

                // Finalize entry state logs inside the transaction ledger
                await supabase.from('demo_trades').update({
                    status: statusUpdate,
                    exit_price_usd: simulatedExitPrice,
                    realized_pnl_sol: netSolPnL,
                    pnl_percentage: priceChangePct,
                    exited_at: new Date().toISOString()
                }).eq('id', trade.id);

                console.log(`[🏁 CLOSED VIRTUAL POSITION] Asset: ${trade.token_symbol} | Out: ${statusUpdate} | PnL: ${priceChangePct.toFixed(2)}%`);
            }
        }

        return res.status(200).json({ success: true, processed: openTrades.length });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
}