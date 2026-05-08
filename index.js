import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const MODULE = "moa_collab";

const defaultSettings = {
    enabled: false,
    mode: "sequential", // sequential(串行精修) | parallel(并行汇总)
    rounds: 2,
    aggregator: null, // 最终聚合模型ID
    agents: [
        // { id, name, apiUrl, apiKey, model, role, enabled }
    ]
};

// ============ 初始化设置 ============
function loadSettings() {
    extension_settings[MODULE] = extension_settings[MODULE] || structuredClone(defaultSettings);
    const s = extension_settings[MODULE];
    for (const k in defaultSettings) if (!(k in s)) s[k] = defaultSettings[k];
    return s;
}

// ============ API 调用封装（OpenAI兼容） ============
async function callModel(agent, messages, signal) {
    const url = agent.apiUrl.replace(/\/+$/,'') + "/chat/completions";
    const body = {
        model: agent.model,
        messages: messages,
        temperature: agent.temperature ?? 0.8,
        stream: false
    };
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${agent.apiKey}`
        },
        body: JSON.stringify(body),
        signal
    });
    if (!res.ok) throw new Error(`[${agent.name}] HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
}

// ============ 拉取模型列表 ============
async function fetchModels(apiUrl, apiKey) {
    const url = apiUrl.replace(/\/+$/,'') + "/models";
    const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${apiKey}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || data.models || []).map(m => m.id || m.name);
}

// ============ 协作核心 ============
/**
 * 串行模式：A 写初稿 → B 改 → C 再改 → ...
 * 并行模式：所有 agent 各写一稿 → aggregator 综合输出
 */
async function runCollaboration(userPrompt, contextMessages) {
    const s = extension_settings[MODULE];
    const agents = s.agents.filter(a => a.enabled);
    if (agents.length === 0) throw new Error("没有启用的协作模型");

    const log = (msg) => console.log(`%c[MoA]%c ${msg}`, "color:#a78bfa;font-weight:bold", "");

    if (s.mode === "sequential") {
        let draft = "";
        for (let r = 0; r < s.rounds; r++) {
            for (const agent of agents) {
                const sysPrompt = draft
                    ? `你是${agent.name}（角色：${agent.role||"协作者"}）。这是上一位作者的草稿，请基于你的视角进行改进、补全、润色，保留有价值的部分，输出完整新版本。\n\n上一版草稿：\n${draft}`
                    : `你是${agent.name}（角色：${agent.role||"作者"}）。请根据用户请求撰写初稿。`;

                const messages = [
                    ...contextMessages,
                    { role: "system", content: sysPrompt },
                    { role: "user", content: userPrompt }
                ];
                log(`轮次${r+1} - ${agent.name} 工作中...`);
                draft = await callModel(agent, messages);
                log(`✓ ${agent.name} 完成 (${draft.length}字)`);
            }
        }
        return draft;
    }

    // 并行模式
    log(`并行调用 ${agents.length} 个 agent...`);
    const drafts = await Promise.all(agents.map(async a => {
        const messages = [
            ...contextMessages,
            { role: "system", content: `你是${a.name}（${a.role||"作者"}）。请独立完成下面的请求。` },
            { role: "user", content: userPrompt }
        ];
        try { return { name: a.name, text: await callModel(a, messages) }; }
        catch(e) { return { name: a.name, text: `[失败:${e.message}]` }; }
    }));

    const agg = s.agents.find(a => a.id === s.aggregator) || agents[0];
    const aggPrompt = `以下是${drafts.length}位作者对同一请求的回复。请你作为总编辑，综合各家所长，融合成一份最佳的最终回复。\n\n` +
        drafts.map((d,i)=>`【作者${i+1}：${d.name}】\n${d.text}`).join("\n\n---\n\n");

    log(`聚合器 ${agg.name} 综合中...`);
    return await callModel(agg, [
        ...contextMessages,
        { role: "system", content: aggPrompt },
        { role: "user", content: userPrompt }
    ]);
}

// ============ 拦截 ST 生成 ============
async function onGenerate(type, options, dryRun) {
    const s = extension_settings[MODULE];
    if (!s.enabled || dryRun) return;

    const ctx = getContext();
    const lastUser = [...ctx.chat].reverse().find(m => m.is_user);
    if (!lastUser) return;

    try {
        toastr.info("MoA 多模型协作启动...", "", { timeOut: 2000 });
        const history = ctx.chat.slice(-10).map(m => ({
            role: m.is_user ? "user" : "assistant",
            content: m.mes
        }));
        const finalText = await runCollaboration(lastUser.mes, history);

        // 阻止默认生成，写入消息
        ctx.chat.push({
            name: ctx.name2,
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: finalText,
            extra: { moa: true }
        });
        await ctx.saveChat();
        ctx.reloadCurrentChat();
        toastr.success("MoA 协作完成");

        // 阻断默认流程
        throw new Error("__MOA_INTERCEPT__");
    } catch (e) {
        if (e.message !== "__MOA_INTERCEPT__") {
            toastr.error(`MoA 失败: ${e.message}`);
            console.error(e);
        }
        throw e;
    }
}

// ============ UI 渲染 ============
function renderAgentList() {
    const s = extension_settings[MODULE];
    const $list = $("#moa_agent_list").empty();
    s.agents.forEach((a, i) => {
        const $row = $(`
        <div class="moa-agent-card" data-idx="${i}">
            <div class="moa-agent-head">
                <input type="checkbox" class="moa-en" ${a.enabled?"checked":""}>
                <input type="text" class="moa-name" placeholder="名称" value="${a.name||""}">
                <input type="text" class="moa-role" placeholder="角色(如:批评家/诗人)" value="${a.role||""}">
                <button class="moa-del menu_button">🗑</button>
            </div>
            <div class="moa-agent-body">
                <input type="text" class="moa-url" placeholder="API URL (如 https://api.openai.com/v1)" value="${a.apiUrl||""}">
                <input type="password" class="moa-key" placeholder="API Key" value="${a.apiKey||""}">
                <div class="moa-model-row">
                    <input type="text" class="moa-model" placeholder="模型ID" value="${a.model||""}" list="moa_models_${i}">
                    <datalist id="moa_models_${i}"></datalist>
                    <button class="moa-pull menu_button">📥 拉取模型</button>
                </div>
            </div>
        </div>`);
        $list.append($row);
    });
}

function bindEvents() {
    const s = extension_settings[MODULE];

    $("#moa_enabled").on("change", function(){ s.enabled = this.checked; saveSettingsDebounced(); });
    $("#moa_mode").on("change", function(){ s.mode = this.value; saveSettingsDebounced(); refreshAggregator(); });
    $("#moa_rounds").on("input", function(){ s.rounds = parseInt(this.value)||1; saveSettingsDebounced(); });
    $("#moa_aggregator").on("change", function(){ s.aggregator = this.value; saveSettingsDebounced(); });

    $("#moa_add_agent").on("click", () => {
        s.agents.push({
            id: "ag_" + Date.now(),
            name: "Agent " + (s.agents.length+1),
            apiUrl: "https://api.openai.com/v1",
            apiKey: "", model: "", role: "", enabled: true
        });
        saveSettingsDebounced();
        renderAgentList();
        refreshAggregator();
    });

    $(document).on("click", ".moa-del", function(){
        const i = $(this).closest(".moa-agent-card").data("idx");
        s.agents.splice(i,1);
        saveSettingsDebounced();
        renderAgentList();
        refreshAggregator();
    });

    $(document).on("change input", ".moa-agent-card input", function(){
        const $card = $(this).closest(".moa-agent-card");
        const i = $card.data("idx");
        const a = s.agents[i];
        a.enabled = $card.find(".moa-en").is(":checked");
        a.name = $card.find(".moa-name").val();
        a.role = $card.find(".moa-role").val();
        a.apiUrl = $card.find(".moa-url").val();
        a.apiKey = $card.find(".moa-key").val();
        a.model = $card.find(".moa-model").val();
        saveSettingsDebounced();
        refreshAggregator();
    });

    $(document).on("click", ".moa-pull", async function(){
        const $card = $(this).closest(".moa-agent-card");
        const i = $card.data("idx");
        const a = s.agents[i];
        try {
            $(this).text("拉取中...");
            const models = await fetchModels(a.apiUrl, a.apiKey);
            const $dl = $card.find("datalist").empty();
            models.forEach(m => $dl.append(`<option value="${m}">`));
            toastr.success(`拉取到 ${models.length} 个模型`);
        } catch(e) {
            toastr.error("拉取失败: " + e.message);
        } finally { $(this).text("📥 拉取模型"); }
    });
}

function refreshAggregator() {
    const s = extension_settings[MODULE];
    const $sel = $("#moa_aggregator").empty();
    $sel.append(`<option value="">(默认第一个)</option>`);
    s.agents.forEach(a => $sel.append(`<option value="${a.id}" ${s.aggregator===a.id?"selected":""}>${a.name}</option>`));
}

// ============ 入口 ============
jQuery(async () => {
    const settingsHtml = await $.get(`/scripts/extensions/third-party/ST-MoA-Collab/settings.html`);
    $("#extensions_settings").append(settingsHtml);

    const s = loadSettings();
    $("#moa_enabled").prop("checked", s.enabled);
    $("#moa_mode").val(s.mode);
    $("#moa_rounds").val(s.rounds);

    renderAgentList();
    refreshAggregator();
    bindEvents();

    // 监听生成事件
    eventSource.on(event_types.GENERATION_STARTED, onGenerate);

    console.log("[MoA Collab] 已加载 ✅");
});
