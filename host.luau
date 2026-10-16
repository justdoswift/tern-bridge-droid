--!strict

type Preferences = { bunPath: string?, droidPath: string?, locale: string? }

local function preferences(): Preferences
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(tern.plugin.data .. "/preferences.json"))
	end)
	if not ok or type(value) ~= "table" then return {} end
	return {
		bunPath = if type(value.bunPath) == "string" and value.bunPath ~= "" then value.bunPath else nil,
		droidPath = if type(value.droidPath) == "string" and value.droidPath ~= "" then value.droidPath else nil,
		locale = if value.locale == "en-US" then "en-US" else "zh-CN",
	}
end

-- Only new panes on the host running this plugin inherit the launcher. No shell
-- profiles, existing terminal input, or programs on another host are rewritten.
tern.on("spawn", function(spec: SpawnSpec): SpawnSpec?
	if tern.runtime.os ~= "macos" and tern.runtime.os ~= "linux" then return nil end
	if string.match(spec.program, "([^/]+)$") ~= "zsh" then return nil end
	local current = preferences()
	spec.env.TERN_DROID_BRIDGE_DIR = tern.plugin.dir
	spec.env.TERN_DROID_BRIDGE_DATA = tern.plugin.data
	spec.env.TERN_DROID_BRIDGE_BUN = current.bunPath or "bun"
	spec.env.TERN_DROID_BRIDGE_DROID = current.droidPath or "droid"
	spec.env.TERN_DROID_BRIDGE_LOCALE = current.locale or "zh-CN"
	local zdotdir = spec.env.ZDOTDIR or tern.getenv("ZDOTDIR")
	spec.env.TERN_DROID_BRIDGE_ZDOTDIR = zdotdir or ""
	spec.env.TERN_DROID_BRIDGE_ZDOTDIR_SET = if zdotdir == nil then "0" else "1"
	spec.env.ZDOTDIR = tern.plugin.dir .. "/shell/zsh"
	return spec
end)
