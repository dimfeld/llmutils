local function extract_cursor_planning_code_snippets_map(response_content, current_filepath, current_filetype)
  local snippets = {}
  local lines = vim.split(response_content, "\n")
  local cumulated_content = ""

  -- use tree-sitter-markdown to parse all code blocks in response_content
  local lang = "unknown"
  for _, node in ipairs(tree_sitter_markdown_parse_code_blocks(response_content)) do
    if node:type() == "language" then
      lang = vim.treesitter.get_node_text(node, response_content)
      lang = vim.split(lang, ":")[1]
    elseif node:type() == "code_fence_content" then
      local start_line, _ = node:start()
      local end_line, _ = node:end_()
      local filepath, skip_next_line = obtain_filepath_from_codeblock(lines, start_line)
      if filepath == nil or filepath == "" then
        if lang == current_filetype then
          filepath = current_filepath
        else
          Utils.warn(
            string.format(
              "Failed to parse filepath from code block, and current_filetype `%s` is not the same as the filetype `%s` of the current code block, so ignore this code block",
              current_filetype,
              lang
            )
          )
          lang = "unknown"
          goto continue
        end
      end
      if skip_next_line then start_line = start_line + 1 end
      local this_content = table.concat(vim.list_slice(lines, start_line + 1, end_line), "\n")
      cumulated_content = cumulated_content .. "\n" .. this_content
      table.insert(snippets, {
        range = { 0, 0 },
        content = cumulated_content,
        lang = lang,
        filepath = filepath,
        start_line_in_response_buf = start_line,
        end_line_in_response_buf = end_line + 1,
      })
    end
    ::continue::
  end

  local snippets_map = {}
  for _, snippet in ipairs(snippets) do
    snippets_map[snippet.filepath] = snippets_map[snippet.filepath] or {}
    table.insert(snippets_map[snippet.filepath], snippet)
  end

  return snippets_map
end

if opts.mode == "cursor-applying" then
  local user_prompt = [[
Merge all changes from the <update> snippet into the <code> below.
- Preserve the code's structure, order, comments, and indentation exactly.
- Output only the updated code, enclosed within <updated-code> and </updated-code> tags.
- Do not include any additional text, explanations, placeholders, ellipses, or code fences.

]]
  user_prompt = user_prompt .. string.format("<code>\n%s\n</code>\n", opts.original_code)
  for _, snippet in ipairs(opts.update_snippets) do
    user_prompt = user_prompt .. string.format("<update>\n%s\n</update>\n", snippet)
  end
  user_prompt = user_prompt .. "Provide the complete updated code."
  table.insert(messages, { role = "user", content = user_prompt })
end

if Config.behaviour.enable_cursor_planning_mode then
  for filepath, snippets in pairs(selected_snippets_map) do
    local original_code_lines = Utils.read_file_from_buf_or_disk(filepath)
    if not original_code_lines then
      Utils.error("Failed to read file: " .. filepath)
      return
    end
    local formated_snippets = vim.iter(snippets):map(function(snippet) return snippet.content end):totable()
    local original_code = table.concat(original_code_lines, "\n")
    local resp_content = ""
    local filetype = Utils.get_filetype(filepath)
    local cursor_applying_provider_name = Config.cursor_applying_provider or Config.provider
    Utils.debug(string.format("Use %s for cursor applying", cursor_applying_provider_name))
    local cursor_applying_provider = Provider[cursor_applying_provider_name]
    if not cursor_applying_provider then
      Utils.error("Failed to find cursor_applying_provider provider: " .. cursor_applying_provider_name, {
        once = true,
        title = "Avante",
      })
    end
    if self.code.winid ~= nil and api.nvim_win_is_valid(self.code.winid) then
      api.nvim_set_current_win(self.code.winid)
    end
    local bufnr = Utils.get_or_create_buffer_with_filepath(filepath)
    local path_ = PPath:new(filepath)
    path_:parent():mkdir({ parents = true, exists_ok = true })

    local ns_id = api.nvim_create_namespace("avante_live_diff")

    local function clear_highlights() api.nvim_buf_clear_namespace(bufnr, ns_id, 0, -1) end

   
  

    clear_highlights()

    local last_processed_line = 0
    local last_orig_diff_end_line = 1
    local last_resp_diff_end_line = 1
    local cleaned = false
    local prev_patch = {}

    local function get_stable_patch(patch)
      local new_patch = {}
      for _, hunk in ipairs(patch) do
        local start_a, count_a, start_b, count_b = unpack(hunk)
        start_a = start_a + last_orig_diff_end_line - 1
        start_b = start_b + last_resp_diff_end_line - 1
        local has = vim.iter(prev_patch):find(function(hunk_)
          local start_a_, count_a_, start_b_, count_b_ = unpack(hunk_)
          return start_a == start_a_ and start_b == start_b_ and count_a == count_a_ and count_b == count_b_
        end)
        if has ~= nil then table.insert(new_patch, hunk) end
      end
      return new_patch
    end

    local extmark_id_map = {}
    local virt_lines_map = {}

    Llm.stream({
      ask = true,
      provider = cursor_applying_provider,
      code_lang = filetype,
      mode = "cursor-applying",
      original_code = original_code,
      update_snippets = formated_snippets,
      on_start = function(_) end,
      on_chunk = function(chunk)
        if not chunk then return end

        resp_content = resp_content .. chunk

        if not cleaned then
          resp_content = resp_content:gsub("<updated%-code>\n*", ""):gsub("</updated%-code>\n*", "")
          resp_content = resp_content:gsub(".*```%w+\n", ""):gsub("\n```\n.*", "")
        end

        local resp_lines = vim.split(resp_content, "\n")

        local complete_lines_count = #resp_lines - 1
        if complete_lines_count > 2 then cleaned = true end

        if complete_lines_count <= last_processed_line then return end

        local original_lines_to_process =
          vim.list_slice(original_code_lines, last_orig_diff_end_line, complete_lines_count)
        local resp_lines_to_process = vim.list_slice(resp_lines, last_resp_diff_end_line, complete_lines_count)

        local resp_lines_content = table.concat(resp_lines_to_process, "\n")
        local original_lines_content = table.concat(original_lines_to_process, "\n")

        ---@diagnostic disable-next-line: assign-type-mismatch, missing-fields
        local patch = vim.diff(original_lines_content, resp_lines_content, { ---@type integer[][]
          algorithm = "histogram",
          result_type = "indices",
          ctxlen = vim.o.scrolloff,
        })

        local stable_patch = get_stable_patch(patch)

        for _, hunk in ipairs(stable_patch) do
          local start_a, count_a, start_b, count_b = unpack(hunk)

          start_a = last_orig_diff_end_line + start_a - 1

          if count_a > 0 then
            api.nvim_buf_set_extmark(bufnr, ns_id, start_a - 1, 0, {
              hl_group = Highlights.TO_BE_DELETED_WITHOUT_STRIKETHROUGH,
              hl_eol = true,
              hl_mode = "combine",
              end_row = start_a + count_a - 1,
            })
          end

          if count_b == 0 then goto continue end

          local new_lines = vim.list_slice(resp_lines_to_process, start_b, start_b + count_b - 1)
          local max_col = vim.o.columns
          local virt_lines = vim
            .iter(new_lines)
            :map(function(line)
              --- append spaces to the end of the line
              local line_ = line .. string.rep(" ", max_col - #line)
              return { { line_, Highlights.INCOMING } }
            end)
            :totable()
          local extmark_line
          if count_a > 0 then
            extmark_line = math.max(0, start_a + count_a - 2)
          else
            extmark_line = math.max(0, start_a + count_a - 1)
          end
          local old_extmark_id = extmark_id_map[extmark_line]
          if old_extmark_id ~= nil then
            local old_virt_lines = virt_lines_map[old_extmark_id] or {}
            virt_lines = vim.list_extend(old_virt_lines, virt_lines)
            api.nvim_buf_del_extmark(bufnr, ns_id, old_extmark_id)
          end
          local extmark_id = api.nvim_buf_set_extmark(bufnr, ns_id, extmark_line, 0, {
            virt_lines = virt_lines,
            hl_eol = true,
            hl_mode = "combine",
          })
          extmark_id_map[extmark_line] = extmark_id
          virt_lines_map[extmark_id] = virt_lines
          ::continue::
        end

        prev_patch = vim
          .iter(patch)
          :map(function(hunk)
            local start_a, count_a, start_b, count_b = unpack(hunk)
            return { last_orig_diff_end_line + start_a - 1, count_a, last_resp_diff_end_line + start_b - 1, count_b }
          end)
          :totable()

        if #stable_patch > 0 then
          local start_a, count_a, start_b, count_b = unpack(stable_patch[#stable_patch])
          last_orig_diff_end_line = last_orig_diff_end_line + start_a + math.max(count_a, 1) - 1
          last_resp_diff_end_line = last_resp_diff_end_line + start_b + math.max(count_b, 1) - 1
        end

        if #patch == 0 then
          last_orig_diff_end_line = complete_lines_count + 1
          last_resp_diff_end_line = complete_lines_count + 1
        end

        last_processed_line = complete_lines_count

        local winid = Utils.get_winid(bufnr)

        if winid == nil then return end

        --- goto window winid
        api.nvim_set_current_win(winid)
        --- goto the last line
        pcall(function() api.nvim_win_set_cursor(winid, { complete_lines_count, 0 }) end)
        vim.cmd("normal! zz")
      end,
      on_stop = function(stop_opts)
        clear_highlights()
        close_loading_window()

        if stop_opts.error ~= nil then
          Utils.error(string.format("applying failed: %s", vim.inspect(stop_opts.error)))
          return
        end

        resp_content = resp_content:gsub("<updated%-code>\n*", ""):gsub("</updated%-code>\n*", "")

        resp_content = resp_content:gsub(".*```%w+\n", ""):gsub("\n```\n.*", ""):gsub("\n```$", "")

        local resp_lines = vim.split(resp_content, "\n")

        if require("avante.config").debug then
          local resp_content_file = fn.tempname() .. ".txt"
          fn.writefile(vim.split(resp_content, "\n"), resp_content_file)
          Utils.debug("cursor applying response content written to: " .. resp_content_file)
        end

        if resp_content == original_code then return end

        ---@diagnostic disable-next-line: assign-type-mismatch, missing-fields
        local patch = vim.diff(original_code, resp_content, { ---@type integer[][]
          algorithm = "histogram",
          result_type = "indices",
          ctxlen = vim.o.scrolloff,
        })

        local new_lines = {}
        local prev_start_a = 1
        for _, hunk in ipairs(patch) do
          local start_a, count_a, start_b, count_b = unpack(hunk)
          if count_a > 0 then
            vim.list_extend(new_lines, vim.list_slice(original_code_lines, prev_start_a, start_a - 1))
          else
            vim.list_extend(new_lines, vim.list_slice(original_code_lines, prev_start_a, start_a))
          end
          prev_start_a = start_a + count_a
          if count_a == 0 then prev_start_a = prev_start_a + 1 end
          table.insert(new_lines, "<<<<<<< HEAD")
          if count_a > 0 then
            vim.list_extend(new_lines, vim.list_slice(original_code_lines, start_a, start_a + count_a - 1))
          end
          table.insert(new_lines, "=======")
          if count_b > 0 then
            vim.list_extend(new_lines, vim.list_slice(resp_lines, start_b, start_b + count_b - 1))
          end
          table.insert(new_lines, ">>>>>>> Snippet")
        end

        local remaining_lines = vim.list_slice(original_code_lines, prev_start_a, #original_code_lines)
        new_lines = vim.list_extend(new_lines, remaining_lines)

        api.nvim_buf_set_lines(bufnr, 0, -1, false, new_lines)

        local function process(winid)
          api.nvim_set_current_win(winid)
          api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "n", true)
          Diff.add_visited_buffer(bufnr)
          Diff.process(bufnr)
          api.nvim_win_set_cursor(winid, { 1, 0 })
          vim.defer_fn(function()
            Diff.find_next(Config.windows.ask.focus_on_apply)
            vim.cmd("normal! zz")
          end, 100)
        end

        local winid = Utils.get_winid(bufnr)
        if winid then
          process(winid)
        else
          api.nvim_create_autocmd("BufWinEnter", {
            buffer = bufnr,
            once = true,
            callback = function()
              local winid_ = Utils.get_winid(bufnr)
              if winid_ then process(winid_) end
            end,
          })
        end
      end,
    })
  end
  return
end



