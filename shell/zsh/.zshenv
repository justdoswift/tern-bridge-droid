# Tern chains the ZDOTDIR supplied by the spawn hook through its own integration.
# Restore the original directory so every author startup file keeps its identity.
if [[ "${TERN_DROID_BRIDGE_ZDOTDIR_SET-0}" == 1 ]]; then
	'builtin' 'export' ZDOTDIR="$TERN_DROID_BRIDGE_ZDOTDIR"
else
	'builtin' 'unset' 'ZDOTDIR'
fi
'builtin' 'unset' 'TERN_DROID_BRIDGE_ZDOTDIR' 'TERN_DROID_BRIDGE_ZDOTDIR_SET'
'builtin' 'typeset' _tern_droid_bridge_zshenv=${ZDOTDIR-~}"/.zshenv"
if [[ -r "$_tern_droid_bridge_zshenv" && ! "$_tern_droid_bridge_zshenv" -ef "${(%):-%x}" ]]; then
	'builtin' 'source' '--' "$_tern_droid_bridge_zshenv"
fi
'builtin' 'unset' '_tern_droid_bridge_zshenv'

# Install only after the author's profiles have run. A pane-local function is
# independent of profile PATH changes and command caches; explicit user aliases
# and functions keep precedence. `command droid` still runs the official CLI.
if [[ -o interactive ]]; then
	_tern_droid_bridge_ready() {
		if (( ! $+aliases[droid] && ! $+functions[droid] )); then
			function droid { "$TERN_DROID_BRIDGE_DIR/bin/droid" "$@" }
		fi
		precmd_functions=("${(@)precmd_functions:#_tern_droid_bridge_ready}")
		'builtin' 'unfunction' '_tern_droid_bridge_ready'
		'builtin' 'return' 0
	}
	'builtin' 'typeset' -ga precmd_functions
	precmd_functions+=(_tern_droid_bridge_ready)
fi
