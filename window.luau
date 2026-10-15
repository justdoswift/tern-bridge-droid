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
