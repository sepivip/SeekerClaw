// tools/session.js — session_status handler

const {
    log, config, localDateStr,
    AGENT_NAME, MODEL,
} = require('../config');

const { getDb } = require('../database');

const { conversations } = require('../claude');

const { loadSkills } = require('../skills');

const tools = [
    {
        name: 'session_status',
        description: 'Get current session info including uptime, memory usage, model, conversation stats, AND API usage analytics from your SQL.js database (today\'s request count, token usage, avg latency, error rate, cache hit rate).',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
];

const handlers = {
    async session_status(input, chatId) {
        const uptime = Math.floor(process.uptime());
        const memUsage = process.memoryUsage();
        const totalConversations = conversations.size;
        let totalMessages = 0;
        conversations.forEach(conv => totalMessages += conv.length);

        const result = {
            agent: AGENT_NAME,
            model: MODEL,
            uptime: {
                seconds: uptime,
                formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`
            },
            memory: {
                rss: Math.round(memUsage.rss / 1024 / 1024),
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                external: Math.round(memUsage.external / 1024 / 1024)
            },
            conversations: {
                active: totalConversations,
                totalMessages: totalMessages
            },
            runtime: {
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch
            },
            features: {
                webSearch: true,
                webSearchProvider: config.braveApiKey ? 'brave' : 'duckduckgo',
                reminders: true,
                skills: loadSkills().length
            }
        };

        // API usage analytics from SQL.js (BAT-28)
        if (getDb()) {
            try {
                const today = localDateStr();
                const todayStats = getDb().exec(
                    `SELECT COUNT(*) as cnt,
                            COALESCE(SUM(input_tokens), 0) as inp,
                            COALESCE(SUM(output_tokens), 0) as outp,
                            COALESCE(AVG(duration_ms), 0) as avg_ms,
                            COALESCE(SUM(cache_read_tokens), 0) as cache_read,
                            COALESCE(SUM(cache_creation_tokens), 0) as cache_create,
                            SUM(CASE WHEN status != 200 THEN 1 ELSE 0 END) as errors
                     FROM api_request_log WHERE timestamp LIKE ?`, [today + '%']
                );
                if (todayStats.length > 0 && todayStats[0].values.length > 0) {
                    const [cnt, inp, outp, avgMs, cacheRead, , errors] = todayStats[0].values[0];
                    const totalTokens = (inp || 0) + (outp || 0);
                    const cacheHitRate = (inp || 0) > 0
                        ? Math.round(((cacheRead || 0) / (inp || 1)) * 100)
                        : 0;
                    result.apiUsage = {
                        today: {
                            requests: cnt || 0,
                            inputTokens: inp || 0,
                            outputTokens: outp || 0,
                            totalTokens,
                            avgLatencyMs: Math.round(avgMs || 0),
                            errors: errors || 0,
                            errorRate: cnt > 0 ? `${Math.round(((errors || 0) / cnt) * 100)}%` : '0%',
                            cacheHitRate: `${cacheHitRate}%`,
                        }
                    };
                }
            } catch (e) {
                // Non-fatal — analytics section just won't appear
            }
        }

        return result;
    },
};

module.exports = { tools, handlers };
