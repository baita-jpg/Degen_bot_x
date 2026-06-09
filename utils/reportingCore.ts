// utils/reportingCore.ts (Append to bottom)

/**
 * Maps an array of normalized data points [0.0 - 1.0] to visual block characters
 */
function generateAsciiSparkline(data: number[]): string {
    if (data.length === 0) return '';
    const ticks = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min;
    
    if (range === 0) return ticks[3].repeat(data.length); // Flat line

    return data.map(val => {
        const normalized = (val - min) / range;
        const index = Math.min(Math.floor(normalized * ticks.length), ticks.length - 1);
        return ticks[index];
    }).join('');
}

/**
 * Compiles trade history into a cumulative equity curve
 */
export async function generateEquityCurve(supabase: any, userId: number, accountType: string): Promise<string> {
    const table = accountType === 'DEMO_PAPER' ? 'demo_trades' : 'user_trades';
    const timeColumn = accountType === 'DEMO_PAPER' ? 'entered_at' : 'executed_at';
    
    const { data: trades, error } = await supabase
        .from(table)
        .select('*')
        .eq('tg_user_id', userId)
        .order(timeColumn, { ascending: true })
        .limit(20); // Track last 20 trades for the visual window

    if (error || !trades || trades.length < 2) {
        return "Not enough data to plot trajectory.";
    }

    let cumulativePnL = 0;
    const equityPath: number[] = [0]; // Start at baseline

    trades.forEach((trade: any) => {
        const pnl = parseFloat(trade.realized_pnl_sol || trade.sol_amount * (parseFloat(trade.pnl_percentage || 0) / 100) || 0);
        cumulativePnL += pnl;
        equityPath.push(cumulativePnL);
    });

    const sparkline = generateAsciiSparkline(equityPath);
    const trend = cumulativePnL >= 0 ? '🟢 BULLISH EXPANSION' : '🔴 BEARISH DRAWDOWN';

    return `[${sparkline}] ${trend}`;
}