/**
 * Native, byte-for-byte reproductions of cobra v1.10.2's static shell
 * completion script templates.
 *
 * cobra's `bash`/`zsh`/`fish`/`powershell` completion scripts are 100%
 * generic string templates — they do NOT bake in the command tree. Every
 * tab press, the generated script shells back out to the running
 * `supabase` binary's hidden `__complete`/`__completeNoDesc` command (see
 * `legacy/cli/legacy-complete.ts`) to get live candidates. The
 * only variables in the whole template are the program name (always the
 * literal `"supabase"` — cobra derives it from `Use: "supabase"` in
 * `apps/cli-go/cmd/root.go`, a compile-time constant, not `os.Argv[0]`),
 * which hidden command the script calls back into (`__complete` by
 * default, `__completeNoDesc` when generated with `--no-descriptions`),
 * the six `ShellCompDirective` bit values, and the two activeHelp
 * constants.
 *
 * Transcribed directly from the cobra v1.10.2 source (verified byte-exact
 * via a scripted round-trip against `fmt.Sprintf` semantics):
 *   - bash_completionsV2.go   (genBashComp)
 *   - zsh_completions.go      (genZshComp)
 *   - fish_completions.go     (genFishComp)
 *   - powershell_completions.go (genPowerShellComp)
 *   - completions.go          (ShellCompDirective / ShellCompRequestCmd constants)
 */

const PROGRAM_NAME = "supabase";

const SHELL_COMP_REQUEST_CMD = "__complete";
const SHELL_COMP_NO_DESC_REQUEST_CMD = "__completeNoDesc";
type CompletionRequestCmd = typeof SHELL_COMP_REQUEST_CMD | typeof SHELL_COMP_NO_DESC_REQUEST_CMD;

/** `ShellCompDirective` bit values (`spf13/cobra@v1.10.2/completions.go:56-96`). */
const SHELL_COMP_DIRECTIVE_ERROR = 1;
const SHELL_COMP_DIRECTIVE_NO_SPACE = 2;
const SHELL_COMP_DIRECTIVE_NO_FILE_COMP = 4;
const SHELL_COMP_DIRECTIVE_FILTER_FILE_EXT = 8;
const SHELL_COMP_DIRECTIVE_FILTER_DIRS = 16;
const SHELL_COMP_DIRECTIVE_KEEP_ORDER = 32;

/** `activeHelpMarker` (`spf13/cobra@v1.10.2/active_help.go:23`). */
const ACTIVE_HELP_MARKER = "_activeHelp_ ";
/** `activeHelpEnvVar("supabase")` (`spf13/cobra@v1.10.2/active_help.go:58`). */
const ACTIVE_HELP_ENV_VAR = "SUPABASE_ACTIVE_HELP";

/**
 * Transcribed from `genBashComp` (`spf13/cobra@v1.10.2/bash_completionsV2.go:31-467`).
 * Backing both `GenBashCompletionV2(w, true)` and `GenBashCompletionV2(w, false)` —
 * cobra funnels both through the same template; only the `compCmd` token differs.
 */
function genBashCompletionScript(programName: string, compCmd: CompletionRequestCmd): string {
  return `# bash completion V2 for ${programName.padEnd(36)} -*- shell-script -*-

__${programName}_debug()
{
    if [[ -n \${BASH_COMP_DEBUG_FILE-} ]]; then
        echo "$*" >> "\${BASH_COMP_DEBUG_FILE}"
    fi
}

# Macs have bash3 for which the bash-completion package doesn't include
# _init_completion. This is a minimal version of that function.
__${programName}_init_completion()
{
    COMPREPLY=()
    _get_comp_words_by_ref "$@" cur prev words cword
}

# This function calls the ${programName} program to obtain the completion
# results and the directive.  It fills the 'out' and 'directive' vars.
__${programName}_get_completion_results() {
    local requestComp lastParam lastChar args

    # Prepare the command to request completions for the program.
    # Calling \${words[0]} instead of directly ${programName} allows handling aliases
    args=("\${words[@]:1}")
    requestComp="\${words[0]} ${compCmd} \${args[*]}"

    lastParam=\${words[$((\${#words[@]}-1))]}
    lastChar=\${lastParam:$((\${#lastParam}-1)):1}
    __${programName}_debug "lastParam \${lastParam}, lastChar \${lastChar}"

    if [[ -z \${cur} && \${lastChar} != = ]]; then
        # If the last parameter is complete (there is a space following it)
        # We add an extra empty parameter so we can indicate this to the go method.
        __${programName}_debug "Adding extra empty parameter"
        requestComp="\${requestComp} ''"
    fi

    # When completing a flag with an = (e.g., ${programName} -n=<TAB>)
    # bash focuses on the part after the =, so we need to remove
    # the flag part from $cur
    if [[ \${cur} == -*=* ]]; then
        cur="\${cur#*=}"
    fi

    __${programName}_debug "Calling \${requestComp}"
    # Use eval to handle any environment variables and such
    out=$(eval "\${requestComp}" 2>/dev/null)

    # Extract the directive integer at the very end of the output following a colon (:)
    directive=\${out##*:}
    # Remove the directive
    out=\${out%:*}
    if [[ \${directive} == "\${out}" ]]; then
        # There is not directive specified
        directive=0
    fi
    __${programName}_debug "The completion directive is: \${directive}"
    __${programName}_debug "The completions are: \${out}"
}

__${programName}_process_completion_results() {
    local shellCompDirectiveError=${SHELL_COMP_DIRECTIVE_ERROR}
    local shellCompDirectiveNoSpace=${SHELL_COMP_DIRECTIVE_NO_SPACE}
    local shellCompDirectiveNoFileComp=${SHELL_COMP_DIRECTIVE_NO_FILE_COMP}
    local shellCompDirectiveFilterFileExt=${SHELL_COMP_DIRECTIVE_FILTER_FILE_EXT}
    local shellCompDirectiveFilterDirs=${SHELL_COMP_DIRECTIVE_FILTER_DIRS}
    local shellCompDirectiveKeepOrder=${SHELL_COMP_DIRECTIVE_KEEP_ORDER}

    if (((directive & shellCompDirectiveError) != 0)); then
        # Error code.  No completion.
        __${programName}_debug "Received error from custom completion go code"
        return
    else
        if (((directive & shellCompDirectiveNoSpace) != 0)); then
            if [[ $(type -t compopt) == builtin ]]; then
                __${programName}_debug "Activating no space"
                compopt -o nospace
            else
                __${programName}_debug "No space directive not supported in this version of bash"
            fi
        fi
        if (((directive & shellCompDirectiveKeepOrder) != 0)); then
            if [[ $(type -t compopt) == builtin ]]; then
                # no sort isn't supported for bash less than < 4.4
                if [[ \${BASH_VERSINFO[0]} -lt 4 || ( \${BASH_VERSINFO[0]} -eq 4 && \${BASH_VERSINFO[1]} -lt 4 ) ]]; then
                    __${programName}_debug "No sort directive not supported in this version of bash"
                else
                    __${programName}_debug "Activating keep order"
                    compopt -o nosort
                fi
            else
                __${programName}_debug "No sort directive not supported in this version of bash"
            fi
        fi
        if (((directive & shellCompDirectiveNoFileComp) != 0)); then
            if [[ $(type -t compopt) == builtin ]]; then
                __${programName}_debug "Activating no file completion"
                compopt +o default
            else
                __${programName}_debug "No file completion directive not supported in this version of bash"
            fi
        fi
    fi

    # Separate activeHelp from normal completions
    local completions=()
    local activeHelp=()
    __${programName}_extract_activeHelp

    if (((directive & shellCompDirectiveFilterFileExt) != 0)); then
        # File extension filtering
        local fullFilter="" filter filteringCmd

        # Do not use quotes around the $completions variable or else newline
        # characters will be kept.
        for filter in \${completions[*]}; do
            fullFilter+="$filter|"
        done

        filteringCmd="_filedir $fullFilter"
        __${programName}_debug "File filtering command: $filteringCmd"
        $filteringCmd
    elif (((directive & shellCompDirectiveFilterDirs) != 0)); then
        # File completion for directories only

        local subdir
        subdir=\${completions[0]}
        if [[ -n $subdir ]]; then
            __${programName}_debug "Listing directories in $subdir"
            pushd "$subdir" >/dev/null 2>&1 && _filedir -d && popd >/dev/null 2>&1 || return
        else
            __${programName}_debug "Listing directories in ."
            _filedir -d
        fi
    else
        __${programName}_handle_completion_types
    fi

    __${programName}_handle_special_char "$cur" :
    __${programName}_handle_special_char "$cur" =

    # Print the activeHelp statements before we finish
    __${programName}_handle_activeHelp
}

__${programName}_handle_activeHelp() {
    # Print the activeHelp statements
    if ((\${#activeHelp[*]} != 0)); then
        if [ -z $COMP_TYPE ]; then
            # Bash v3 does not set the COMP_TYPE variable.
            printf "\\n";
            printf "%s\\n" "\${activeHelp[@]}"
            printf "\\n"
            __${programName}_reprint_commandLine
            return
        fi

        # Only print ActiveHelp on the second TAB press
        if [ $COMP_TYPE -eq 63 ]; then
            printf "\\n"
            printf "%s\\n" "\${activeHelp[@]}"

            if ((\${#COMPREPLY[*]} == 0)); then
                # When there are no completion choices from the program, file completion
                # may kick in if the program has not disabled it; in such a case, we want
                # to know if any files will match what the user typed, so that we know if
                # there will be completions presented, so that we know how to handle ActiveHelp.
                # To find out, we actually trigger the file completion ourselves;
                # the call to _filedir will fill COMPREPLY if files match.
                if (((directive & shellCompDirectiveNoFileComp) == 0)); then
                    __${programName}_debug "Listing files"
                    _filedir
                fi
            fi

            if ((\${#COMPREPLY[*]} != 0)); then
                # If there are completion choices to be shown, print a delimiter.
                # Re-printing the command-line will automatically be done
                # by the shell when it prints the completion choices.
                printf -- "--"
            else
                # When there are no completion choices at all, we need
                # to re-print the command-line since the shell will
                # not be doing it itself.
                __${programName}_reprint_commandLine
            fi
        elif [ $COMP_TYPE -eq 37 ] || [ $COMP_TYPE -eq 42 ]; then
            # For completion type: menu-complete/menu-complete-backward and insert-completions
            # the completions are immediately inserted into the command-line, so we first
            # print the activeHelp message and reprint the command-line since the shell won't.
            printf "\\n"
            printf "%s\\n" "\${activeHelp[@]}"

            __${programName}_reprint_commandLine
        fi
    fi
}

__${programName}_reprint_commandLine() {
    # The prompt format is only available from bash 4.4.
    # We test if it is available before using it.
    if (x=\${PS1@P}) 2> /dev/null; then
        printf "%s" "\${PS1@P}\${COMP_LINE[@]}"
    else
        # Can't print the prompt.  Just print the
        # text the user had typed, it is workable enough.
        printf "%s" "\${COMP_LINE[@]}"
    fi
}

# Separate activeHelp lines from real completions.
# Fills the $activeHelp and $completions arrays.
__${programName}_extract_activeHelp() {
    local activeHelpMarker="${ACTIVE_HELP_MARKER}"
    local endIndex=\${#activeHelpMarker}

    while IFS='' read -r comp; do
        [[ -z $comp ]] && continue

        if [[ \${comp:0:endIndex} == $activeHelpMarker ]]; then
            comp=\${comp:endIndex}
            __${programName}_debug "ActiveHelp found: $comp"
            if [[ -n $comp ]]; then
                activeHelp+=("$comp")
            fi
        else
            # Not an activeHelp line but a normal completion
            completions+=("$comp")
        fi
    done <<<"\${out}"
}

__${programName}_handle_completion_types() {
    __${programName}_debug "__${programName}_handle_completion_types: COMP_TYPE is $COMP_TYPE"

    case $COMP_TYPE in
    37|42)
        # Type: menu-complete/menu-complete-backward and insert-completions
        # If the user requested inserting one completion at a time, or all
        # completions at once on the command-line we must remove the descriptions.
        # https://github.com/spf13/cobra/issues/1508

        # If there are no completions, we don't need to do anything
        (( \${#completions[@]} == 0 )) && return 0

        local tab=$'\\t'

        # Strip any description and escape the completion to handled special characters
        IFS=$'\\n' read -ra completions -d '' < <(printf "%q\\n" "\${completions[@]%%$tab*}")

        # Only consider the completions that match
        IFS=$'\\n' read -ra COMPREPLY -d '' < <(IFS=$'\\n'; compgen -W "\${completions[*]}" -- "\${cur}")

        # compgen looses the escaping so we need to escape all completions again since they will
        # all be inserted on the command-line.
        IFS=$'\\n' read -ra COMPREPLY -d '' < <(printf "%q\\n" "\${COMPREPLY[@]}")
        ;;

    *)
        # Type: complete (normal completion)
        __${programName}_handle_standard_completion_case
        ;;
    esac
}

__${programName}_handle_standard_completion_case() {
    local tab=$'\\t'

    # If there are no completions, we don't need to do anything
    (( \${#completions[@]} == 0 )) && return 0

    # Short circuit to optimize if we don't have descriptions
    if [[ "\${completions[*]}" != *$tab* ]]; then
        # First, escape the completions to handle special characters
        IFS=$'\\n' read -ra completions -d '' < <(printf "%q\\n" "\${completions[@]}")
        # Only consider the completions that match what the user typed
        IFS=$'\\n' read -ra COMPREPLY -d '' < <(IFS=$'\\n'; compgen -W "\${completions[*]}" -- "\${cur}")

        # compgen looses the escaping so, if there is only a single completion, we need to
        # escape it again because it will be inserted on the command-line.  If there are multiple
        # completions, we don't want to escape them because they will be printed in a list
        # and we don't want to show escape characters in that list.
        if (( \${#COMPREPLY[@]} == 1 )); then
            COMPREPLY[0]=$(printf "%q" "\${COMPREPLY[0]}")
        fi
        return 0
    fi

    local longest=0
    local compline
    # Look for the longest completion so that we can format things nicely
    while IFS='' read -r compline; do
        [[ -z $compline ]] && continue

        # Before checking if the completion matches what the user typed,
        # we need to strip any description and escape the completion to handle special
        # characters because those escape characters are part of what the user typed.
        # Don't call "printf" in a sub-shell because it will be much slower
        # since we are in a loop.
        printf -v comp "%q" "\${compline%%$tab*}" &>/dev/null || comp=$(printf "%q" "\${compline%%$tab*}")

        # Only consider the completions that match
        [[ $comp == "$cur"* ]] || continue

        # The completions matches.  Add it to the list of full completions including
        # its description.  We don't escape the completion because it may get printed
        # in a list if there are more than one and we don't want show escape characters
        # in that list.
        COMPREPLY+=("$compline")

        # Strip any description before checking the length, and again, don't escape
        # the completion because this length is only used when printing the completions
        # in a list and we don't want show escape characters in that list.
        comp=\${compline%%$tab*}
        if ((\${#comp}>longest)); then
            longest=\${#comp}
        fi
    done < <(printf "%s\\n" "\${completions[@]}")

    # If there is a single completion left, remove the description text and escape any special characters
    if ((\${#COMPREPLY[*]} == 1)); then
        __${programName}_debug "COMPREPLY[0]: \${COMPREPLY[0]}"
        COMPREPLY[0]=$(printf "%q" "\${COMPREPLY[0]%%$tab*}")
        __${programName}_debug "Removed description from single completion, which is now: \${COMPREPLY[0]}"
    else
        # Format the descriptions
        __${programName}_format_comp_descriptions $longest
    fi
}

__${programName}_handle_special_char()
{
    local comp="$1"
    local char=$2
    if [[ "$comp" == *\${char}* && "$COMP_WORDBREAKS" == *\${char}* ]]; then
        local word=\${comp%"\${comp##*\${char}}"}
        local idx=\${#COMPREPLY[*]}
        while ((--idx >= 0)); do
            COMPREPLY[idx]=\${COMPREPLY[idx]#"$word"}
        done
    fi
}

__${programName}_format_comp_descriptions()
{
    local tab=$'\\t'
    local comp desc maxdesclength
    local longest=$1

    local i ci
    for ci in \${!COMPREPLY[*]}; do
        comp=\${COMPREPLY[ci]}
        # Properly format the description string which follows a tab character if there is one
        if [[ "$comp" == *$tab* ]]; then
            __${programName}_debug "Original comp: $comp"
            desc=\${comp#*$tab}
            comp=\${comp%%$tab*}

            # $COLUMNS stores the current shell width.
            # Remove an extra 4 because we add 2 spaces and 2 parentheses.
            maxdesclength=$(( COLUMNS - longest - 4 ))

            # Make sure we can fit a description of at least 8 characters
            # if we are to align the descriptions.
            if ((maxdesclength > 8)); then
                # Add the proper number of spaces to align the descriptions
                for ((i = \${#comp} ; i < longest ; i++)); do
                    comp+=" "
                done
            else
                # Don't pad the descriptions so we can fit more text after the completion
                maxdesclength=$(( COLUMNS - \${#comp} - 4 ))
            fi

            # If there is enough space for any description text,
            # truncate the descriptions that are too long for the shell width
            if ((maxdesclength > 0)); then
                if ((\${#desc} > maxdesclength)); then
                    desc=\${desc:0:$(( maxdesclength - 1 ))}
                    desc+="…"
                fi
                comp+="  ($desc)"
            fi
            COMPREPLY[ci]=$comp
            __${programName}_debug "Final comp: $comp"
        fi
    done
}

__start_${programName}()
{
    local cur prev words cword split

    COMPREPLY=()

    # Call _init_completion from the bash-completion package
    # to prepare the arguments properly
    if declare -F _init_completion >/dev/null 2>&1; then
        _init_completion -n =: || return
    else
        __${programName}_init_completion -n =: || return
    fi

    __${programName}_debug
    __${programName}_debug "========= starting completion logic =========="
    __${programName}_debug "cur is \${cur}, words[*] is \${words[*]}, #words[@] is \${#words[@]}, cword is $cword"

    # The user could have moved the cursor backwards on the command-line.
    # We need to trigger completion from the $cword location, so we need
    # to truncate the command-line ($words) up to the $cword location.
    words=("\${words[@]:0:$cword+1}")
    __${programName}_debug "Truncated words[*]: \${words[*]},"

    local out directive
    __${programName}_get_completion_results
    __${programName}_process_completion_results
}

if [[ $(type -t compopt) = "builtin" ]]; then
    complete -o default -F __start_${programName} ${programName}
else
    complete -o default -o nospace -F __start_${programName} ${programName}
fi

# ex: ts=4 sw=4 et filetype=sh
`;
}

/**
 * Transcribed from `genZshComp` (`spf13/cobra@v1.10.2/zsh_completions.go:87-308`).
 * `GenZshCompletion` and `GenZshCompletionNoDesc` both call this exact function —
 * verified there is no other divergence between the desc/no-desc variants beyond
 * the `compCmd` token.
 */
function genZshCompletionScript(programName: string, compCmd: CompletionRequestCmd): string {
  return `#compdef ${programName}
compdef _${programName} ${programName}

# zsh completion for ${programName.padEnd(36)} -*- shell-script -*-

__${programName}_debug()
{
    local file="$BASH_COMP_DEBUG_FILE"
    if [[ -n \${file} ]]; then
        echo "$*" >> "\${file}"
    fi
}

_${programName}()
{
    local shellCompDirectiveError=${SHELL_COMP_DIRECTIVE_ERROR}
    local shellCompDirectiveNoSpace=${SHELL_COMP_DIRECTIVE_NO_SPACE}
    local shellCompDirectiveNoFileComp=${SHELL_COMP_DIRECTIVE_NO_FILE_COMP}
    local shellCompDirectiveFilterFileExt=${SHELL_COMP_DIRECTIVE_FILTER_FILE_EXT}
    local shellCompDirectiveFilterDirs=${SHELL_COMP_DIRECTIVE_FILTER_DIRS}
    local shellCompDirectiveKeepOrder=${SHELL_COMP_DIRECTIVE_KEEP_ORDER}

    local lastParam lastChar flagPrefix requestComp out directive comp lastComp noSpace keepOrder
    local -a completions

    __${programName}_debug "\\n========= starting completion logic =========="
    __${programName}_debug "CURRENT: \${CURRENT}, words[*]: \${words[*]}"

    # The user could have moved the cursor backwards on the command-line.
    # We need to trigger completion from the $CURRENT location, so we need
    # to truncate the command-line ($words) up to the $CURRENT location.
    # (We cannot use $CURSOR as its value does not work when a command is an alias.)
    words=("\${=words[1,CURRENT]}")
    __${programName}_debug "Truncated words[*]: \${words[*]},"

    lastParam=\${words[-1]}
    lastChar=\${lastParam[-1]}
    __${programName}_debug "lastParam: \${lastParam}, lastChar: \${lastChar}"

    # For zsh, when completing a flag with an = (e.g., ${programName} -n=<TAB>)
    # completions must be prefixed with the flag
    setopt local_options BASH_REMATCH
    if [[ "\${lastParam}" =~ '-.*=' ]]; then
        # We are dealing with a flag with an =
        flagPrefix="-P \${BASH_REMATCH}"
    fi

    # Prepare the command to obtain completions
    requestComp="\${words[1]} ${compCmd} \${words[2,-1]}"
    if [ "\${lastChar}" = "" ]; then
        # If the last parameter is complete (there is a space following it)
        # We add an extra empty parameter so we can indicate this to the go completion code.
        __${programName}_debug "Adding extra empty parameter"
        requestComp="\${requestComp} \\"\\""
    fi

    __${programName}_debug "About to call: eval \${requestComp}"

    # Use eval to handle any environment variables and such
    out=$(eval \${requestComp} 2>/dev/null)
    __${programName}_debug "completion output: \${out}"

    # Extract the directive integer following a : from the last line
    local lastLine
    while IFS='\\n' read -r line; do
        lastLine=\${line}
    done < <(printf "%s\\n" "\${out[@]}")
    __${programName}_debug "last line: \${lastLine}"

    if [ "\${lastLine[1]}" = : ]; then
        directive=\${lastLine[2,-1]}
        # Remove the directive including the : and the newline
        local suffix
        (( suffix=\${#lastLine}+2))
        out=\${out[1,-$suffix]}
    else
        # There is no directive specified.  Leave $out as is.
        __${programName}_debug "No directive found.  Setting do default"
        directive=0
    fi

    __${programName}_debug "directive: \${directive}"
    __${programName}_debug "completions: \${out}"
    __${programName}_debug "flagPrefix: \${flagPrefix}"

    if [ $((directive & shellCompDirectiveError)) -ne 0 ]; then
        __${programName}_debug "Completion received error. Ignoring completions."
        return
    fi

    local activeHelpMarker="${ACTIVE_HELP_MARKER}"
    local endIndex=\${#activeHelpMarker}
    local startIndex=$((\${#activeHelpMarker}+1))
    local hasActiveHelp=0
    while IFS='\\n' read -r comp; do
        # Check if this is an activeHelp statement (i.e., prefixed with $activeHelpMarker)
        if [ "\${comp[1,$endIndex]}" = "$activeHelpMarker" ];then
            __${programName}_debug "ActiveHelp found: $comp"
            comp="\${comp[$startIndex,-1]}"
            if [ -n "$comp" ]; then
                compadd -x "\${comp}"
                __${programName}_debug "ActiveHelp will need delimiter"
                hasActiveHelp=1
            fi

            continue
        fi

        if [ -n "$comp" ]; then
            # If requested, completions are returned with a description.
            # The description is preceded by a TAB character.
            # For zsh's _describe, we need to use a : instead of a TAB.
            # We first need to escape any : as part of the completion itself.
            comp=\${comp//:/\\\\:}

            local tab="$(printf '\\t')"
            comp=\${comp//$tab/:}

            __${programName}_debug "Adding completion: \${comp}"
            completions+=\${comp}
            lastComp=$comp
        fi
    done < <(printf "%s\\n" "\${out[@]}")

    # Add a delimiter after the activeHelp statements, but only if:
    # - there are completions following the activeHelp statements, or
    # - file completion will be performed (so there will be choices after the activeHelp)
    if [ $hasActiveHelp -eq 1 ]; then
        if [ \${#completions} -ne 0 ] || [ $((directive & shellCompDirectiveNoFileComp)) -eq 0 ]; then
            __${programName}_debug "Adding activeHelp delimiter"
            compadd -x "--"
            hasActiveHelp=0
        fi
    fi

    if [ $((directive & shellCompDirectiveNoSpace)) -ne 0 ]; then
        __${programName}_debug "Activating nospace."
        noSpace="-S ''"
    fi

    if [ $((directive & shellCompDirectiveKeepOrder)) -ne 0 ]; then
        __${programName}_debug "Activating keep order."
        keepOrder="-V"
    fi

    if [ $((directive & shellCompDirectiveFilterFileExt)) -ne 0 ]; then
        # File extension filtering
        local filteringCmd
        filteringCmd='_files'
        for filter in \${completions[@]}; do
            if [ \${filter[1]} != '*' ]; then
                # zsh requires a glob pattern to do file filtering
                filter="\\*.$filter"
            fi
            filteringCmd+=" -g $filter"
        done
        filteringCmd+=" \${flagPrefix}"

        __${programName}_debug "File filtering command: $filteringCmd"
        _arguments '*:filename:'"$filteringCmd"
    elif [ $((directive & shellCompDirectiveFilterDirs)) -ne 0 ]; then
        # File completion for directories only
        local subdir
        subdir="\${completions[1]}"
        if [ -n "$subdir" ]; then
            __${programName}_debug "Listing directories in $subdir"
            pushd "\${subdir}" >/dev/null 2>&1
        else
            __${programName}_debug "Listing directories in ."
        fi

        local result
        _arguments '*:dirname:_files -/'" \${flagPrefix}"
        result=$?
        if [ -n "$subdir" ]; then
            popd >/dev/null 2>&1
        fi
        return $result
    else
        __${programName}_debug "Calling _describe"
        if eval _describe $keepOrder "completions" completions $flagPrefix $noSpace; then
            __${programName}_debug "_describe found some completions"

            # Return the success of having called _describe
            return 0
        else
            __${programName}_debug "_describe did not find completions."
            __${programName}_debug "Checking if we should do file completion."
            if [ $((directive & shellCompDirectiveNoFileComp)) -ne 0 ]; then
                __${programName}_debug "deactivating file completion"

                # We must return an error code here to let zsh know that there were no
                # completions found by _describe; this is what will trigger other
                # matching algorithms to attempt to find completions.
                # For example zsh can match letters in the middle of words.
                return 1
            else
                # Perform file completion
                __${programName}_debug "Activating file completion"

                # We must return the result of this command, so it must be the
                # last command, or else we must store its result to return it.
                _arguments '*:filename:_files'" \${flagPrefix}"
            fi
        fi
    fi
}

# don't run the completion function when being source-ed or eval-ed
if [ "$funcstack[1]" = "_${programName}" ]; then
    _${programName}
fi
`;
}

/**
 * Transcribed from `genFishComp` (`spf13/cobra@v1.10.2/fish_completions.go:25-273`).
 * cobra emits the header comment via a separate `fmt.Sprintf` call before the main
 * template; reproduced here as a plain string concatenation of the two pieces.
 */
function genFishCompletionScript(programName: string, compCmd: CompletionRequestCmd): string {
  return (
    `# fish completion for ${programName.padEnd(36)} -*- shell-script -*-\n` +
    `
function __${programName}_debug
    set -l file "$BASH_COMP_DEBUG_FILE"
    if test -n "$file"
        echo "$argv" >> $file
    end
end

function __${programName}_perform_completion
    __${programName}_debug "Starting __${programName}_perform_completion"

    # Extract all args except the last one
    set -l args (commandline -opc)
    # Extract the last arg and escape it in case it is a space
    set -l lastArg (string escape -- (commandline -ct))

    __${programName}_debug "args: $args"
    __${programName}_debug "last arg: $lastArg"

    # Disable ActiveHelp which is not supported for fish shell
    set -l requestComp "${ACTIVE_HELP_ENV_VAR}=0 $args[1] ${compCmd} $args[2..-1] $lastArg"

    __${programName}_debug "Calling $requestComp"
    set -l results (eval $requestComp 2> /dev/null)

    # Some programs may output extra empty lines after the directive.
    # Let's ignore them or else it will break completion.
    # Ref: https://github.com/spf13/cobra/issues/1279
    for line in $results[-1..1]
        if test (string trim -- $line) = ""
            # Found an empty line, remove it
            set results $results[1..-2]
        else
            # Found non-empty line, we have our proper output
            break
        end
    end

    set -l comps $results[1..-2]
    set -l directiveLine $results[-1]

    # For Fish, when completing a flag with an = (e.g., <program> -n=<TAB>)
    # completions must be prefixed with the flag
    set -l flagPrefix (string match -r -- '-.*=' "$lastArg")

    __${programName}_debug "Comps: $comps"
    __${programName}_debug "DirectiveLine: $directiveLine"
    __${programName}_debug "flagPrefix: $flagPrefix"

    for comp in $comps
        printf "%s%s\\n" "$flagPrefix" "$comp"
    end

    printf "%s\\n" "$directiveLine"
end

# this function limits calls to __${programName}_perform_completion, by caching the result behind $__${programName}_perform_completion_once_result
function __${programName}_perform_completion_once
    __${programName}_debug "Starting __${programName}_perform_completion_once"

    if test -n "$__${programName}_perform_completion_once_result"
        __${programName}_debug "Seems like a valid result already exists, skipping __${programName}_perform_completion"
        return 0
    end

    set --global __${programName}_perform_completion_once_result (__${programName}_perform_completion)
    if test -z "$__${programName}_perform_completion_once_result"
        __${programName}_debug "No completions, probably due to a failure"
        return 1
    end

    __${programName}_debug "Performed completions and set __${programName}_perform_completion_once_result"
    return 0
end

# this function is used to clear the $__${programName}_perform_completion_once_result variable after completions are run
function __${programName}_clear_perform_completion_once_result
    __${programName}_debug ""
    __${programName}_debug "========= clearing previously set __${programName}_perform_completion_once_result variable =========="
    set --erase __${programName}_perform_completion_once_result
    __${programName}_debug "Successfully erased the variable __${programName}_perform_completion_once_result"
end

function __${programName}_requires_order_preservation
    __${programName}_debug ""
    __${programName}_debug "========= checking if order preservation is required =========="

    __${programName}_perform_completion_once
    if test -z "$__${programName}_perform_completion_once_result"
        __${programName}_debug "Error determining if order preservation is required"
        return 1
    end

    set -l directive (string sub --start 2 $__${programName}_perform_completion_once_result[-1])
    __${programName}_debug "Directive is: $directive"

    set -l shellCompDirectiveKeepOrder ${SHELL_COMP_DIRECTIVE_KEEP_ORDER}
    set -l keeporder (math (math --scale 0 $directive / $shellCompDirectiveKeepOrder) % 2)
    __${programName}_debug "Keeporder is: $keeporder"

    if test $keeporder -ne 0
        __${programName}_debug "This does require order preservation"
        return 0
    end

    __${programName}_debug "This doesn't require order preservation"
    return 1
end


# This function does two things:
# - Obtain the completions and store them in the global __${programName}_comp_results
# - Return false if file completion should be performed
function __${programName}_prepare_completions
    __${programName}_debug ""
    __${programName}_debug "========= starting completion logic =========="

    # Start fresh
    set --erase __${programName}_comp_results

    __${programName}_perform_completion_once
    __${programName}_debug "Completion results: $__${programName}_perform_completion_once_result"

    if test -z "$__${programName}_perform_completion_once_result"
        __${programName}_debug "No completion, probably due to a failure"
        # Might as well do file completion, in case it helps
        return 1
    end

    set -l directive (string sub --start 2 $__${programName}_perform_completion_once_result[-1])
    set --global __${programName}_comp_results $__${programName}_perform_completion_once_result[1..-2]

    __${programName}_debug "Completions are: $__${programName}_comp_results"
    __${programName}_debug "Directive is: $directive"

    set -l shellCompDirectiveError ${SHELL_COMP_DIRECTIVE_ERROR}
    set -l shellCompDirectiveNoSpace ${SHELL_COMP_DIRECTIVE_NO_SPACE}
    set -l shellCompDirectiveNoFileComp ${SHELL_COMP_DIRECTIVE_NO_FILE_COMP}
    set -l shellCompDirectiveFilterFileExt ${SHELL_COMP_DIRECTIVE_FILTER_FILE_EXT}
    set -l shellCompDirectiveFilterDirs ${SHELL_COMP_DIRECTIVE_FILTER_DIRS}

    if test -z "$directive"
        set directive 0
    end

    set -l compErr (math (math --scale 0 $directive / $shellCompDirectiveError) % 2)
    if test $compErr -eq 1
        __${programName}_debug "Received error directive: aborting."
        # Might as well do file completion, in case it helps
        return 1
    end

    set -l filefilter (math (math --scale 0 $directive / $shellCompDirectiveFilterFileExt) % 2)
    set -l dirfilter (math (math --scale 0 $directive / $shellCompDirectiveFilterDirs) % 2)
    if test $filefilter -eq 1; or test $dirfilter -eq 1
        __${programName}_debug "File extension filtering or directory filtering not supported"
        # Do full file completion instead
        return 1
    end

    set -l nospace (math (math --scale 0 $directive / $shellCompDirectiveNoSpace) % 2)
    set -l nofiles (math (math --scale 0 $directive / $shellCompDirectiveNoFileComp) % 2)

    __${programName}_debug "nospace: $nospace, nofiles: $nofiles"

    # If we want to prevent a space, or if file completion is NOT disabled,
    # we need to count the number of valid completions.
    # To do so, we will filter on prefix as the completions we have received
    # may not already be filtered so as to allow fish to match on different
    # criteria than the prefix.
    if test $nospace -ne 0; or test $nofiles -eq 0
        set -l prefix (commandline -t | string escape --style=regex)
        __${programName}_debug "prefix: $prefix"

        set -l completions (string match -r -- "^$prefix.*" $__${programName}_comp_results)
        set --global __${programName}_comp_results $completions
        __${programName}_debug "Filtered completions are: $__${programName}_comp_results"

        # Important not to quote the variable for count to work
        set -l numComps (count $__${programName}_comp_results)
        __${programName}_debug "numComps: $numComps"

        if test $numComps -eq 1; and test $nospace -ne 0
            # We must first split on \\t to get rid of the descriptions to be
            # able to check what the actual completion will be.
            # We don't need descriptions anyway since there is only a single
            # real completion which the shell will expand immediately.
            set -l split (string split --max 1 \\t $__${programName}_comp_results[1])

            # Fish won't add a space if the completion ends with any
            # of the following characters: @=/:.,
            set -l lastChar (string sub -s -1 -- $split)
            if not string match -r -q "[@=/:.,]" -- "$lastChar"
                # In other cases, to support the "nospace" directive we trick the shell
                # by outputting an extra, longer completion.
                __${programName}_debug "Adding second completion to perform nospace directive"
                set --global __${programName}_comp_results $split[1] $split[1].
                __${programName}_debug "Completions are now: $__${programName}_comp_results"
            end
        end

        if test $numComps -eq 0; and test $nofiles -eq 0
            # To be consistent with bash and zsh, we only trigger file
            # completion when there are no other completions
            __${programName}_debug "Requesting file completion"
            return 1
        end
    end

    return 0
end

# Since Fish completions are only loaded once the user triggers them, we trigger them ourselves
# so we can properly delete any completions provided by another script.
# Only do this if the program can be found, or else fish may print some errors; besides,
# the existing completions will only be loaded if the program can be found.
if type -q "${programName}"
    # The space after the program name is essential to trigger completion for the program
    # and not completion of the program name itself.
    # Also, we use '> /dev/null 2>&1' since '&>' is not supported in older versions of fish.
    complete --do-complete "${programName} " > /dev/null 2>&1
end

# Remove any pre-existing completions for the program since we will be handling all of them.
complete -c ${programName} -e

# this will get called after the two calls below and clear the $__${programName}_perform_completion_once_result global
complete -c ${programName} -n '__${programName}_clear_perform_completion_once_result'
# The call to __${programName}_prepare_completions will setup __${programName}_comp_results
# which provides the program's completion choices.
# If this doesn't require order preservation, we don't use the -k flag
complete -c ${programName} -n 'not __${programName}_requires_order_preservation && __${programName}_prepare_completions' -f -a '$__${programName}_comp_results'
# otherwise we use the -k flag
complete -k -c ${programName} -n '__${programName}_requires_order_preservation && __${programName}_prepare_completions' -f -a '$__${programName}_comp_results'
`
  );
}

/**
 * Transcribed from `genPowerShellComp` (`spf13/cobra@v1.10.2/powershell_completions.go:28-311`).
 * `GenPowerShellCompletion` (no desc) and `GenPowerShellCompletionWithDesc` both call
 * this exact function — verified there is no other divergence between the desc/no-desc
 * variants beyond the `compCmd` token. cobra's source builds this template by
 * concatenating raw-string segments with a handful of interpreted (`"..."`)
 * segments so it can embed literal PowerShell backticks (Go raw strings cannot
 * contain a backtick); reproduced here as one TS template literal with those
 * backticks escaped directly, which TS supports natively.
 */
function genPowerShellCompletionScript(programName: string, compCmd: CompletionRequestCmd): string {
  return `# powershell completion for ${programName.padEnd(36)} -*- shell-script -*-

function __${programName}_debug {
    if ($env:BASH_COMP_DEBUG_FILE) {
        "$args" | Out-File -Append -FilePath "$env:BASH_COMP_DEBUG_FILE"
    }
}

filter __${programName}_escapeStringWithSpecialChars {
    $_ -replace '\\s|#|@|\\$|;|,|''|\\{|\\}|\\(|\\)|"|\`|\\||<|>|&','\`$&'
}

[scriptblock]\${__${programName}CompleterBlock} = {
    param(
            $WordToComplete,
            $CommandAst,
            $CursorPosition
        )

    # Get the current command line and convert into a string
    $Command = $CommandAst.CommandElements
    $Command = "$Command"

    __${programName}_debug ""
    __${programName}_debug "========= starting completion logic =========="
    __${programName}_debug "WordToComplete: $WordToComplete Command: $Command CursorPosition: $CursorPosition"

    # The user could have moved the cursor backwards on the command-line.
    # We need to trigger completion from the $CursorPosition location, so we need
    # to truncate the command-line ($Command) up to the $CursorPosition location.
    # Make sure the $Command is longer then the $CursorPosition before we truncate.
    # This happens because the $Command does not include the last space.
    if ($Command.Length -gt $CursorPosition) {
        $Command=$Command.Substring(0,$CursorPosition)
    }
    __${programName}_debug "Truncated command: $Command"

    $ShellCompDirectiveError=${SHELL_COMP_DIRECTIVE_ERROR}
    $ShellCompDirectiveNoSpace=${SHELL_COMP_DIRECTIVE_NO_SPACE}
    $ShellCompDirectiveNoFileComp=${SHELL_COMP_DIRECTIVE_NO_FILE_COMP}
    $ShellCompDirectiveFilterFileExt=${SHELL_COMP_DIRECTIVE_FILTER_FILE_EXT}
    $ShellCompDirectiveFilterDirs=${SHELL_COMP_DIRECTIVE_FILTER_DIRS}
    $ShellCompDirectiveKeepOrder=${SHELL_COMP_DIRECTIVE_KEEP_ORDER}

    # Prepare the command to request completions for the program.
    # Split the command at the first space to separate the program and arguments.
    $Program,$Arguments = $Command.Split(" ",2)

    $RequestComp="$Program ${compCmd} $Arguments"
    __${programName}_debug "RequestComp: $RequestComp"

    # we cannot use $WordToComplete because it
    # has the wrong values if the cursor was moved
    # so use the last argument
    if ($WordToComplete -ne "" ) {
        $WordToComplete = $Arguments.Split(" ")[-1]
    }
    __${programName}_debug "New WordToComplete: $WordToComplete"


    # Check for flag with equal sign
    $IsEqualFlag = ($WordToComplete -Like "--*=*" )
    if ( $IsEqualFlag ) {
        __${programName}_debug "Completing equal sign flag"
        # Remove the flag part
        $Flag,$WordToComplete = $WordToComplete.Split("=",2)
    }

    if ( $WordToComplete -eq "" -And ( -Not $IsEqualFlag )) {
        # If the last parameter is complete (there is a space following it)
        # We add an extra empty parameter so we can indicate this to the go method.
        __${programName}_debug "Adding extra empty parameter"
        # PowerShell 7.2+ changed the way how the arguments are passed to executables,
        # so for pre-7.2 or when Legacy argument passing is enabled we need to use
        # \`"\`" to pass an empty argument, a "" or '' does not work!!!
        if ($PSVersionTable.PsVersion -lt [version]'7.2.0' -or
            ($PSVersionTable.PsVersion -lt [version]'7.3.0' -and -not [ExperimentalFeature]::IsEnabled("PSNativeCommandArgumentPassing")) -or
            (($PSVersionTable.PsVersion -ge [version]'7.3.0' -or [ExperimentalFeature]::IsEnabled("PSNativeCommandArgumentPassing")) -and
              $PSNativeCommandArgumentPassing -eq 'Legacy')) {
             $RequestComp="$RequestComp" + ' \`"\`"'
        } else {
             $RequestComp="$RequestComp" + ' ""'
        }
    }

    __${programName}_debug "Calling $RequestComp"
    # First disable ActiveHelp which is not supported for Powershell
    \${env:${ACTIVE_HELP_ENV_VAR}}=0

    #call the command store the output in $out and redirect stderr and stdout to null
    # $Out is an array contains each line per element
    Invoke-Expression -OutVariable out "$RequestComp" 2>&1 | Out-Null

    # get directive from last line
    [int]$Directive = $Out[-1].TrimStart(':')
    if ($Directive -eq "") {
        # There is no directive specified
        $Directive = 0
    }
    __${programName}_debug "The completion directive is: $Directive"

    # remove directive (last element) from out
    $Out = $Out | Where-Object { $_ -ne $Out[-1] }
    __${programName}_debug "The completions are: $Out"

    if (($Directive -band $ShellCompDirectiveError) -ne 0 ) {
        # Error code.  No completion.
        __${programName}_debug "Received error from custom completion go code"
        return
    }

    $Longest = 0
    [Array]$Values = $Out | ForEach-Object {
        #Split the output in name and description
        $Name, $Description = $_.Split("\`t",2)
        __${programName}_debug "Name: $Name Description: $Description"

        # Look for the longest completion so that we can format things nicely
        if ($Longest -lt $Name.Length) {
            $Longest = $Name.Length
        }

        # Set the description to a one space string if there is none set.
        # This is needed because the CompletionResult does not accept an empty string as argument
        if (-Not $Description) {
            $Description = " "
        }
        New-Object -TypeName PSCustomObject -Property @{
            Name = "$Name"
            Description = "$Description"
        }
    }


    $Space = " "
    if (($Directive -band $ShellCompDirectiveNoSpace) -ne 0 ) {
        # remove the space here
        __${programName}_debug "ShellCompDirectiveNoSpace is called"
        $Space = ""
    }

    if ((($Directive -band $ShellCompDirectiveFilterFileExt) -ne 0 ) -or
       (($Directive -band $ShellCompDirectiveFilterDirs) -ne 0 ))  {
        __${programName}_debug "ShellCompDirectiveFilterFileExt ShellCompDirectiveFilterDirs are not supported"

        # return here to prevent the completion of the extensions
        return
    }

    $Values = $Values | Where-Object {
        # filter the result
        $_.Name -like "$WordToComplete*"

        # Join the flag back if we have an equal sign flag
        if ( $IsEqualFlag ) {
            __${programName}_debug "Join the equal sign flag back to the completion value"
            $_.Name = $Flag + "=" + $_.Name
        }
    }

    # we sort the values in ascending order by name if keep order isn't passed
    if (($Directive -band $ShellCompDirectiveKeepOrder) -eq 0 ) {
        $Values = $Values | Sort-Object -Property Name
    }

    if (($Directive -band $ShellCompDirectiveNoFileComp) -ne 0 ) {
        __${programName}_debug "ShellCompDirectiveNoFileComp is called"

        if ($Values.Length -eq 0) {
            # Just print an empty string here so the
            # shell does not start to complete paths.
            # We cannot use CompletionResult here because
            # it does not accept an empty string as argument.
            ""
            return
        }
    }

    # Get the current mode
    $Mode = (Get-PSReadLineKeyHandler | Where-Object {$_.Key -eq "Tab" }).Function
    __${programName}_debug "Mode: $Mode"

    $Values | ForEach-Object {

        # store temporary because switch will overwrite $_
        $comp = $_

        # PowerShell supports three different completion modes
        # - TabCompleteNext (default windows style - on each key press the next option is displayed)
        # - Complete (works like bash)
        # - MenuComplete (works like zsh)
        # You set the mode with Set-PSReadLineKeyHandler -Key Tab -Function <mode>

        # CompletionResult Arguments:
        # 1) CompletionText text to be used as the auto completion result
        # 2) ListItemText   text to be displayed in the suggestion list
        # 3) ResultType     type of completion result
        # 4) ToolTip        text for the tooltip with details about the object

        switch ($Mode) {

            # bash like
            "Complete" {

                if ($Values.Length -eq 1) {
                    __${programName}_debug "Only one completion left"

                    # insert space after value
                    $CompletionText = $($comp.Name | __${programName}_escapeStringWithSpecialChars) + $Space
                    if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage"){
                        [System.Management.Automation.CompletionResult]::new($CompletionText, "$($comp.Name)", 'ParameterValue', "$($comp.Description)")
                    } else {
                        $CompletionText
                    }

                } else {
                    # Add the proper number of spaces to align the descriptions
                    while($comp.Name.Length -lt $Longest) {
                        $comp.Name = $comp.Name + " "
                    }

                    # Check for empty description and only add parentheses if needed
                    if ($($comp.Description) -eq " " ) {
                        $Description = ""
                    } else {
                        $Description = "  ($($comp.Description))"
                    }

                    $CompletionText = "$($comp.Name)$Description"
                    if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage"){
                        [System.Management.Automation.CompletionResult]::new($CompletionText, "$($comp.Name)$Description", 'ParameterValue', "$($comp.Description)")
                    } else {
                        $CompletionText
                    }
                }
             }

            # zsh like
            "MenuComplete" {
                # insert space after value
                # MenuComplete will automatically show the ToolTip of
                # the highlighted value at the bottom of the suggestions.

                $CompletionText = $($comp.Name | __${programName}_escapeStringWithSpecialChars) + $Space
                if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage"){
                    [System.Management.Automation.CompletionResult]::new($CompletionText, "$($comp.Name)", 'ParameterValue', "$($comp.Description)")
                } else {
                    $CompletionText
                }
            }

            # TabCompleteNext and in case we get something unknown
            Default {
                # Like MenuComplete but we don't want to add a space here because
                # the user need to press space anyway to get the completion.
                # Description will not be shown because that's not possible with TabCompleteNext

                $CompletionText = $($comp.Name | __${programName}_escapeStringWithSpecialChars)
                if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage"){
                    [System.Management.Automation.CompletionResult]::new($CompletionText, "$($comp.Name)", 'ParameterValue', "$($comp.Description)")
                } else {
                    $CompletionText
                }
            }
        }

    }
}

Register-ArgumentCompleter -CommandName '${programName}' -ScriptBlock \${__${programName}CompleterBlock}
`;
}

export type LegacyCompletionShell = "bash" | "zsh" | "fish" | "powershell";

/**
 * Generates the exact script cobra v1.10.2's `supabase completion <shell>`
 * would have produced, without shelling out to (or otherwise depending on)
 * the Go binary.
 */
export function legacyGenerateCompletionScript(
  shell: LegacyCompletionShell,
  options: { readonly noDescriptions: boolean },
): string {
  const compCmd: CompletionRequestCmd = options.noDescriptions
    ? SHELL_COMP_NO_DESC_REQUEST_CMD
    : SHELL_COMP_REQUEST_CMD;

  switch (shell) {
    case "bash":
      return genBashCompletionScript(PROGRAM_NAME, compCmd);
    case "zsh":
      return genZshCompletionScript(PROGRAM_NAME, compCmd);
    case "fish":
      return genFishCompletionScript(PROGRAM_NAME, compCmd);
    case "powershell":
      return genPowerShellCompletionScript(PROGRAM_NAME, compCmd);
  }
}
