import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { getContext } from "../../../extensions.js";

const MODULE = "moa_collab";

const defaultSettings = {
    enabled: false,
    mode: "sequential",
    rounds: 2,
    aggregator: "",
    agents: []
};

// ============== 内联 HTML（关键改动） ==============
const SETTINGS_HTML = `
<div id="moa_collab_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🤖 MoA 多模型协作</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input type="checkbox" id="moa_enabled">
                <span>启用多模型协作</span>
            </label>
            <label for="moa_mode">协作模式：</label>
            <select id="moa_mode" class="text_pole">
                <option value="sequential">串行精修（A→B→C 接力）</option>
                <option value="parallel">并行汇总（多人同写+聚合）</option>
            </select>
            <label for="moa_rounds">串行轮次：</label>
            <input type="number" id="moa_rounds" min="1" max="5" value="2" class="text_pole">
            <label for="moa_aggregator">聚合器（并行模式）：</label>
            <select id="moa_aggregator" class="text_pole"></select>
            <hr>
            <h4>🧩 Agent 列表</h4>
            <div id="moa_agent_list"></div>
            <div class="menu_button" id="moa_add_agent">➕ 添加 Agent</div>
            <small style="opacity:.7;display:block;margin-top:10px;">
                支持 OpenAI 兼容接口（OpenAI / DeepSeek / Ollama / OneAPI 等）<br>
                Ollama: <code>http://localhost:11434/v1</code>
            </small>
        </div>
    </div>
</div>
`;

// ============== API 调用 ==============
async function callModel(agent, messages) {
    const url = agent.apiUrl.replace(/\/+$/, '') + "/chat/completions";
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${agent.apiKey}`
        },
        body: JSON.stringify({
            model: agent.model,
            messages: messages,
            temperature: 0.8,
            stream: false
        })
    });
    if (!res.ok) throw new Error(`[${agent.name}] HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
}

async function fetchModels(apiUrl, apiKey) {
    const url = apiUrl.replace(/\/+$/, '') + "/models";
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || data.models || []).map(m => m.id || m.name);
}

// ============== 协作核心 ==============
async function runCollaboration(userPrompt, history) {
    const s = extension_settings[MODULE];
    const agents = s.agents.filter(a => a.enabled && a.apiUrl && a.model);
    if (agents.length === 0) throw new Error("没有可用的 Agent");

    if (s.mode === "sequential") {
        let draft = "";
        for (let r = 0; r < s.rounds; r++) {
            for (const ag of agents) {
                const sys = draft
                    ? `你是${ag.name}（${ag.role || "协作者"}）。请基于上版草稿改进润色，输出完整新版本。\n\n上版：\n${draft}`
                    : `你是${ag.name}（${ag.role || "作者"}）。请撰写初稿。`;
                draft = await callModel(ag, [
                    ...history,
                    { role: "system", content: sys },
                    { role: "user", content: userPrompt }
                ]);
                toastr.info(`${ag.name} 完成第${r+1}轮`, "MoA", { timeOut: 1500 });
            }
        }
        return draft;
    }

    // parallel
    const drafts = await Promise.all(agents.map(async ag => {
        try {
            const text = await callModel(ag, [
                ...history,
                { role: "system", content: `你是${ag.name}（${ag.role || "作者"}），独立完成请求。` },
                { role: "user", content: userPrompt }
            ]);
            return { name: ag.name, text };
        } catch (e) { return { name: ag.name, text: `[失败:${e.message}]` }; }
    }));

    const agg = s.agents.find(a => a.id === s.aggregator) || agents[0];
    const aggSys = `你是总编辑。综合下面 ${drafts.length} 位作者的回复，融合成一份最佳最终版：\n\n` +
        drafts.map((d, i) => `【${i+1}.${d.name}】\n${d.text}`).join("\n\n---\n\n");
    return await callModel(agg, [
        ...history,
        { role: "system", content: aggSys },
        { role: "user", content: userPrompt }
    ]);
}

// ============== UI ==============
function renderAgents() {
    const s = extension_settings[MODULE];
    const $list = $("#moa_agent_list").empty();
    s.agents.forEach((a, i) => {
        $list.append(`
        <div class="moa-card" data-idx="${i}">
            <div class="moa-row">
                <input type="checkbox" class="moa-en" ${a.enabled ? "checked" : ""}>
                <input type="text" class="moa-name text_pole" placeholder="名称" value="${a.name || ""}">
                <input type="text" class="moa-role text_pole" placeholder="角色" value="${a.role || ""}">
                <div class="menu_button moa-del">🗑</div>
            </div>
            <input type="text" class="moa-url text_pole" placeholder="API URL" value="${a.apiUrl || ""}">
            <input type="password" class="moa-key text_pole" placeholder="API Key" value="${a.apiKey || ""}">
            <div class="moa-row">
                <input type="text" class="moa-model text_pole" placeholder="模型ID" value="${a.model || ""}" list="moa_dl_${i}">
                <datalist id="moa_dl_${i}"></datalist>
                <div class="menu_button moa-pull">📥 拉取</div>
            </div>
        </div>`);
    });
}

function refreshAgg() {
    const s = extension_settings[MODULE];
    const $sel = $("#moa_aggregator").empty().append(`<option value="">(默认第一个)</option>`);
    s.agents.forEach(a => $sel.append(`<option value="${a.id}" ${s.aggregator === a.id ? "selected" : ""}>${a.name}</option>`));
}

function bindUI() {
    const s = extension_settings[MODULE];

    $("#moa_enabled").on("change", function () { s.enabled = this.checked; saveSettingsDebounced(); });
    $("#moa_mode").on("change", function () { s.mode = this.value; saveSettingsDebounced(); });
    $("#moa_rounds").on("input", function () { s.rounds = parseInt(this.value) || 1; saveSettingsDebounced(); });
    $("#moa_aggregator").on("change", function () { s.aggregator = this.value; saveSettingsDebounced(); });

    $("#moa_add_agent").on("click", () => {
        s.agents.push({
            id: "ag_" + Date.now(),
            name: "Agent " + (s.agents.length + 1),
            apiUrl: "https://api.openai.com/v1",
            apiKey: "", model: "", role: "", enabled: true
        });
        saveSettingsDebounced();
        renderAgents();
        refreshAgg();
    });

    $(document).on("click", "#moa_agent_list .moa-del", function () {
        const i = $(this).closest(".moa-card").data("idx");
        s.agents.splice(i, 1);
        saveSettingsDebounced();
        renderAgents();
        refreshAgg();
    });

    $(document).on("change input", "#moa_agent_list .moa-card input", function () {
        const $c = $(this).closest(".moa-card");
        const i = $c.data("idx");
        const a = s.agents[i];
        a.enabled = $c.find(".moa-en").is(":checked");
        a.name = $c.find(".moa-name").val();
        a.role = $c.find(".moa-role").val();
        a.apiUrl = $c.find(".moa-url").val();
        a.apiKey = $c.find(".moa-key").val();
        a.model = $c.find(".moa-model").val();
        saveSettingsDebounced();
        refreshAgg();
    });

    $(document).on("click", "#moa_agent_list .moa-pull", async function () {
        const $c = $(this).closest(".moa-card");
        const i = $c.data("idx");
        const a = extension_settings[MODULE].agents[i];
        const $btn = $(this);
        const old = $btn.text();
        $btn.text("...");
        try {
            const list = await fetchModels(a.apiUrl, a.apiKey);
            const $dl = $c.find("datalist").empty();
            list.forEach(m => $dl.append(`<option value="${m}">`));
            toastr.success(`拉取 ${list.length} 个模型`);
        } catch (e) {
            toastr.error("拉取失败: " + e.message);
        } finally { $btn.text(old); }
    });
}

// ============== 拦截生成 ==============
async function onGenStart() {
    const s = extension_settings[MODULE];
    if (!s.enabled) return;
    const ctx = getContext();
    const lastUser = [...ctx.chat].reverse().find(m => m.is_user);
    if (!lastUser) return;

    try {
        toastr.info("MoA 协作启动...");
        const history = ctx.chat.slice(-8).map(m => ({
            role: m.is_user ? "user" : "assistant",
            content: m.mes
        }));
        const finalText = await runCollaboration(lastUser.mes, history);
        ctx.chat.push({
            name: ctx.name2, is_user: false, is_system: false,
            send_date: Date.now(), mes: finalText, extra: { moa: true }
        });
        await ctx.saveChat();
        ctx.reloadCurrentChat();
        toastr.success("MoA 完成");
    } catch (e) {
        toastr.error("MoA: " + e.message);
        console.error("[MoA]", e);
    }
}

// ============== 入口 ==============
jQuery(() => {
    try {
        // 初始化设置
        extension_settings[MODULE] = extension_settings[MODULE] || structuredClone(defaultSettings);
        const s = extension_settings[MODULE];
        for (const k in defaultSettings) if (!(k in s)) s[k] = defaultSettings[k];

        // 注入 UI
        $("#extensions_settings2").append(SETTINGS_HTML);

        $("#moa_enabled").prop("checked", s.enabled);
        $("#moa_mode").val(s.mode);
        $("#moa_rounds").val(s.rounds);

        renderAgents();
        refreshAgg();
        bindUI();

        eventSource.on(event_types.GENERATION_STARTED, onGenStart);

        console.log("%c[MoA Collab] ✅ 已加载", "color:#a78bfa;font-weight:bold");
    } catch (e) {
        console.error("[MoA Collab] 加载失败:", e);
    }
});
