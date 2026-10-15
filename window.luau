--!strict

local function preferences(): { [string]: any }
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(tern.plugin.data .. "/preferences.json"))
	end)
	if ok and type(value) == "table" then
		return value
	end
	return {}
end

local prefs = preferences()
local english = prefs.locale == "en-US"
local function label(zh: string, en: string): string
	return if english then en else zh
end

-- Progress OSC 9;4 owns task state; a live Bun process alone is not working.
-- Keep the marker cosmetic: never overwrite the owner's native tab color.
local activityTimer: TimerHandle? = nil
local activityCss = ""
local function refreshActivity(cx: WindowCx, waking: boolean?)
	local working: { [number]: boolean } = {}
	local hasDroid = waking == true
	for _, pane in cx.session:panes() do
		if string.sub(pane.title, 1, #"Droid · ") == "Droid · " then
			hasDroid = true
			break
		end
	end
	for _, agent in cx.agents:list() do
		local pane = cx.session:pane(agent.pane)
		if pane and string.sub(pane.title, 1, #"Droid · ") == "Droid · " and agent.state ~= "exited" then
			hasDroid = true
			if agent.state == "working" and pane.tab then
				working[pane.tab] = true
			end
		end
	end
	local current: number? = nil
	for _, session in cx.session:sessions() do
		if session.current then current = session.id break end
	end
	local rules: { string } = {}
	for _, tab in cx.session:tabs() do
		if tab.session == current and working[tab.id] then
			-- Both chrome presentations follow TabInfo's one-based session order.
			local selector = string.format(
				"#tabbar .tb-tabs > .tt:nth-child(%d), #sidebar .nav-group.g-sp-cur .nav-items > div > .nav-row:nth-child(%d)",
				tab.position, tab.position
			)
			local right = if tab.color then 23 else 9
			table.insert(rules, selector .. "{position:relative;padding-right:" .. tostring(right + 14) .. "px}")
			local dot = string.gsub(selector, ",", "::after,") .. "::after"
			table.insert(rules, dot .. "{content:'';position:absolute;right:" .. tostring(right)
				.. "px;top:50%;transform:translateY(-50%);width:7px;height:7px;border-radius:50%;background:var(--ok);pointer-events:none}")
		end
	end
	local css = table.concat(rules, "\n")
	if css ~= activityCss then
		activityCss = css
		tern.css("droid-activity", css)
	end
	if hasDroid and activityTimer == nil then
		-- There is no window progress event. Observe only while a Droid pane lives.
		activityTimer = tern.timer(500, function(nextCx)
			activityTimer = nil
			if nextCx then refreshActivity(nextCx) end
		end)
	elseif not hasDroid and activityTimer then
		activityTimer:cancel()
		activityTimer = nil
	end
end

tern.on("window_start", function(cx) refreshActivity(cx) end)
tern.on("title", function(event, cx)
	-- Title can arrive before the native agent surface is discoverable.
	refreshActivity(cx, string.sub(event.title, 1, #"Droid · ") == "Droid · ")
end)
for _, event in { "focus", "pane_created", "pane_closed", "tab_created", "tab_closed", "command_started", "command_finished" } do
	tern.on(event, function(_event, cx) refreshActivity(cx) end)
end

local function quote(value: string): string
	return "'" .. string.gsub(value, "'", "'\\''") .. "'"
end

local function launch(cx: WindowCx, split: boolean, pick: boolean)
	if tern.runtime.os ~= "macos" and tern.runtime.os ~= "linux" then
		cx:toast("error", label("当前插件启动器仅支持 macOS 和 Linux。", "This plugin launcher supports macOS and Linux only."))
		return
	end
	if cx.hosts:current().kind ~= "local" then
		cx:toast("error", label("请在本机窗格中打开 Droid，远程主机尚未适配。", "Open Droid in a local pane. Remote hosts are not supported."))
		return
	end
	local bundle = tern.plugin.dir .. "/dist/client.mjs"
	if not tern.fs.exists(bundle) then
		cx:toast("error", label("插件缺少客户端文件，请先运行 npm run build。", "The client bundle is missing. Run npm run build first."))
		return
	end
	local current = preferences()
	local bun = if type(current.bunPath) == "string" and current.bunPath ~= "" then current.bunPath else "bun"
	local cwd = tern.getenv("HOME") or "/tmp"
	local focused = cx.session:focused()
	if focused then
		for _, pane in cx.session:panes() do
			if pane.pane == focused and pane.cwd ~= "" then
				cwd = pane.cwd
				break
			end
		end
	end
	local command = "exec " .. quote(bun) .. " " .. quote(bundle)
		.. " --cwd " .. quote(cwd) .. " --data-dir " .. quote(tern.plugin.data)
	if pick then
		command ..= " --pick-session"
	end
	if type(current.droidPath) == "string" and current.droidPath ~= "" then
		command ..= " --droid " .. quote(current.droidPath)
	end
	local pane = if split and focused then cx.layout:split(focused, "right", { cwd = cwd, command = command })
		else cx.layout:new_tab({ cwd = cwd, command = command })
	if not pane then
		cx:toast("error", label("无法打开 Droid 窗格。", "Could not open the Droid pane."))
	elseif activityTimer == nil then
		activityTimer = tern.timer(500, function(nextCx)
			activityTimer = nil
			if nextCx then refreshActivity(nextCx, true) end
		end)
	end
end

tern.command({
	id = "new",
	title = label("Droid：新建原生对话", "Droid: New native conversation"),
	group = "Droid",
	icon = "sparkle",
	run = function(cx) launch(cx, false, false) end,
})
tern.command({
	id = "resume",
	title = label("Droid：恢复历史会话", "Droid: Resume a conversation"),
	group = "Droid",
	icon = "history",
	run = function(cx) launch(cx, false, true) end,
})
tern.command({
	id = "split",
	title = label("Droid：在右侧分屏打开", "Droid: Open in a right split"),
	group = "Droid",
	icon = "split",
	run = function(cx) launch(cx, true, false) end,
})
