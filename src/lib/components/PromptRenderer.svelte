<script lang="ts">
  import type { ActivePrompt } from '$lib/types/session.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { extractCommandAfterCd } from '$common/prefix_prompt_utils.js';

  let {
    prompt,
    connectionId,
  }: {
    prompt: ActivePrompt;
    connectionId: string;
  } = $props();
  const sessionManager = useSessionManager();

  let defaultInputValue = $derived(String(prompt.promptConfig.default ?? ''));
  let defaultSelectedValue = $derived<string | number | boolean>(
    prompt.promptConfig.default ?? prompt.promptConfig.choices?.[0]?.value ?? ''
  );
  let defaultCheckedValues = $derived(
    new Set(prompt.promptConfig.choices?.filter((c) => c.checked).map((c) => c.value) ?? [])
  );

  let inputValue = $state('');
  let selectedValue = $state<string | number | boolean>('');
  let checkedValues = $state<Set<string | number | boolean>>(new Set());
  let sending = $state(false);
  let prefixWordIndex = $state(0);

  let displayCommand = $derived(extractCommandAfterCd(prompt.promptConfig.command ?? ''));
  let commandWords = $derived(displayCommand.split(/\s+/).filter((w) => w.length > 0));

  $effect(() => {
    inputValue = defaultInputValue;
    selectedValue = defaultSelectedValue;
    checkedValues = new Set(defaultCheckedValues);
    prefixWordIndex = commandWords.length - 1;
  });

  async function respond(value: unknown) {
    if (sending) return;
    sending = true;
    try {
      await sessionManager.sendPromptResponse(connectionId, prompt.requestId, value);
    } finally {
      sending = false;
    }
  }

  function handleConfirm(value: boolean) {
    void respond(value);
  }

  function handleInputSubmit() {
    void respond(inputValue);
  }

  function handleInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleInputSubmit();
    }
  }

  function handleSelectSubmit() {
    void respond(selectedValue);
  }

  function handleCheckboxSubmit() {
    void respond([...checkedValues]);
  }

  function handlePrefixSubmit() {
    const selectedPrefix = commandWords.slice(0, prefixWordIndex + 1).join(' ');
    void respond({ exact: false, command: selectedPrefix });
  }

  function handleExactCommand() {
    void respond({ exact: true, command: displayCommand });
  }

  function toggleChecked(value: string | number | boolean) {
    if (checkedValues.has(value)) {
      checkedValues.delete(value);
    } else {
      checkedValues.add(value);
    }
    // Trigger reactivity
    checkedValues = new Set(checkedValues);
  }
</script>

<div class="max-h-full overflow-y-auto border-b border-gray-700 bg-gray-800 px-4 py-3">
  {#if prompt.promptConfig.header}
    <div class="mb-1 text-xs font-semibold text-gray-400 uppercase">
      {prompt.promptConfig.header}
    </div>
  {/if}
  <div class="mb-2 text-sm text-gray-200">{prompt.promptConfig.message}</div>
  {#if prompt.promptConfig.question}
    <div class="mb-2 text-sm text-gray-300">{prompt.promptConfig.question}</div>
  {/if}

  {#if prompt.promptType === 'confirm'}
    <div class="flex gap-2">
      <button
        type="button"
        class="rounded px-3 py-1.5 text-sm font-medium transition-colors
          {prompt.promptConfig.default === true || prompt.promptConfig.default == null
          ? 'bg-blue-600 text-white hover:bg-blue-500'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
        disabled={sending}
        onclick={() => handleConfirm(true)}
      >
        Yes
      </button>
      <button
        type="button"
        class="rounded px-3 py-1.5 text-sm font-medium transition-colors
          {prompt.promptConfig.default === false
          ? 'bg-blue-600 text-white hover:bg-blue-500'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
        disabled={sending}
        onclick={() => handleConfirm(false)}
      >
        No
      </button>
    </div>
  {:else if prompt.promptType === 'input'}
    <div class="flex gap-2">
      <input
        type="text"
        class="min-w-0 flex-1 rounded border border-gray-600 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        bind:value={inputValue}
        placeholder={prompt.promptConfig.validationHint ?? ''}
        disabled={sending}
        onkeydown={handleInputKeydown}
      />
      <button
        type="button"
        class="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        disabled={sending}
        onclick={handleInputSubmit}
      >
        Submit
      </button>
    </div>
    {#if prompt.promptConfig.validationHint}
      <div class="mt-1 text-xs text-gray-500">{prompt.promptConfig.validationHint}</div>
    {/if}
  {:else if prompt.promptType === 'select'}
    <div class="flex flex-col gap-1">
      {#each prompt.promptConfig.choices ?? [] as choice (choice.value)}
        <label
          class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-gray-700"
        >
          <input
            type="radio"
            name="prompt-select-{prompt.requestId}"
            value={choice.value}
            checked={selectedValue === choice.value}
            onchange={() => (selectedValue = choice.value)}
            class="text-blue-600"
          />
          <span class="text-sm text-gray-200">{choice.name}</span>
          {#if choice.description}
            <span class="text-xs text-gray-500">{choice.description}</span>
          {/if}
        </label>
      {/each}
      <button
        type="button"
        class="mt-1 self-start rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        disabled={sending}
        onclick={handleSelectSubmit}
      >
        Submit
      </button>
    </div>
  {:else if prompt.promptType === 'checkbox'}
    <div class="flex flex-col gap-1">
      {#each prompt.promptConfig.choices ?? [] as choice (choice.value)}
        <label
          class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-gray-700"
        >
          <input
            type="checkbox"
            checked={checkedValues.has(choice.value)}
            onchange={() => toggleChecked(choice.value)}
            class="text-blue-600"
          />
          <span class="text-sm text-gray-200">{choice.name}</span>
          {#if choice.description}
            <span class="text-xs text-gray-500">{choice.description}</span>
          {/if}
        </label>
      {/each}
      <button
        type="button"
        class="mt-1 self-start rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        disabled={sending}
        onclick={handleCheckboxSubmit}
      >
        Submit
      </button>
    </div>
  {:else if prompt.promptType === 'prefix_select' && prompt.promptConfig.command?.trim()}
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-0.5 rounded bg-gray-900 px-3 py-2 font-mono text-sm">
        {#each commandWords as word, i}
          <button
            type="button"
            class="rounded px-1 py-0.5 transition-colors {i <= prefixWordIndex
              ? 'text-green-400 hover:bg-green-900/50'
              : 'text-gray-500 hover:bg-gray-700'}"
            disabled={sending}
            onclick={() => (prefixWordIndex = i)}
          >
            {word}
          </button>
        {/each}
      </div>
      <p class="text-xs text-gray-500">
        Click a word to set the prefix boundary. Selected words will be allowed as a command prefix.
      </p>
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          disabled={sending}
          onclick={handlePrefixSubmit}
        >
          Submit Prefix
        </button>
        <button
          type="button"
          class="rounded bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-600"
          disabled={sending}
          onclick={handleExactCommand}
        >
          Allow Exact Command
        </button>
      </div>
    </div>
  {:else}
    <p class="text-sm text-gray-400">
      This prompt type ({prompt.promptType}) is not yet supported in the web UI. Please respond from
      the terminal.
    </p>
  {/if}
</div>
