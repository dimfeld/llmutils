const fence = '```';

export const generateSearchReplacePrompt = `<formatting>
# *SEARCH/REPLACE block* Rules:

Prefer to generate partial diffs of files when most of the file remains unchanged. Use SEARCH/REPLACE blocks for this.

Every *SEARCH/REPLACE block* must use this format:
1. The *FULL* file path alone on a line, verbatim. No bold asterisks, no quotes around it, no escaping of characters, etc.
2. The opening fence and code language, eg: ${fence}python
3. The start of search block: <<<<<<< SEARCH
4. A contiguous chunk of lines to search for in the existing source code.
5. The dividing line: =======
6. The lines to replace into the source code
7. The end of the replace block: >>>>>>> REPLACE
8. The closing fence: ${fence}

Use the *FULL* file path, as shown to you by the user.

Every *SEARCH* section must *EXACTLY MATCH* the file content to be replaced, character for character, including all comments, docstrings, etc.
If the file contains code or other data wrapped/escaped in json/xml/quotes or other containers, you need to propose edits to the literal contents of the file, including the container markup.

Remember to always return enough extra lines around the lines actually being searched so that the SEARCH/REPLACE block can be uniquely identified in the file. But be concise;  ten lines in each direction will usually suffice. Keep it concise, with just enough surrounding context to find the lines.

*SEARCH/REPLACE* blocks will *only* replace the first match occurrence.
Include multiple unique *SEARCH/REPLACE* blocks if needed.

Break large *SEARCH/REPLACE* blocks into a series of smaller blocks that each change a small portion of the file.

Only create *SEARCH/REPLACE* blocks for files that the user has added to the chat!

To move code within a file, use 2 *SEARCH/REPLACE* blocks: 1 to delete it from its current location, 1 to insert it in the new location.

Pay attention to which filenames the user wants you to edit, especially if they are asking you to create a new file.

If you want to put code in a new file, use a *SEARCH/REPLACE block* with:
- A new file path, including dir name if needed
- An empty \`SEARCH\` section
- The new file's contents in the \`REPLACE\` section

To rename files, use shell commands at the end of your response.

If the user just says something like "ok" or "go ahead" or "do that" they probably want you to make SEARCH/REPLACE blocks for the code changes you just proposed.
The user will say when they've applied your edits. If they haven't explicitly confirmed the edits have been applied, they probably want proper SEARCH/REPLACE blocks.

ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!

## SEARCH/REPLACE Block Examples


<example name="Deleting a Block">
mathweb/flask/app.py
${fence}python
<<<<<<< SEARCH
def factorial(n):
    "compute factorial"

    if n == 0:
        return 1
    else:
        return n * factorial(n-1)

=======
>>>>>>> REPLACE
${fence}
</example>

<example name="Changing Lines, with unchanged context in both sides to help with edit placement">
libs/db/schema.ts
${fence}typescript
<<<<<<< SEARCH
 threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id),
    threadItemId: uuid('thread_item_id').references(() => threadItems.id),
    opsTeamId: uuid('ops_team_id').references(() => opsTeams.id),
    fieldTeamId: uuid('field_team_id').references(() => fieldTeams.id),
    data: jsonb('data').notNull().$type<ProcessingEventData>(),
=======
 threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id),
    threadItemId: uuid('thread_item_id').references(() => threadItems.id),
    opsTeamId: uuid('ops_team_id').references(() => opsTeams.id, { onDelete: 'set null' }),
    fieldTeamId: uuid('field_team_id').references(() => fieldTeams.id, { onDelete: 'set null' }),
    data: jsonb('data').notNull().$type<ProcessingEventData>(),
>>>>>>> REPLACE
${fence}

libs/db/schema.ts
${fence}typescript
<<<<<<< SEARCH
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),

    opsTeamId: uuid('ops_team_id').references(() => opsTeams.id),
    fieldTeamId: uuid('field_team_id').references(() => fieldTeams.id),
    fieldTeamMemberId: uuid('field_team_member_id').references(() => users.id),

    processingEventId: uuid('processing_event_id'),
=======
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),

    opsTeamId: uuid('ops_team_id').references(() => opsTeams.id, { onDelete: 'set null' }),
    fieldTeamId: uuid('field_team_id').references(() => fieldTeams.id, { onDelete: 'set null' }),
    fieldTeamMemberId: uuid('field_team_member_id').references(() => users.id),

    processingEventId: uuid('processing_event_id'),
>>>>>>> REPLACE
${fence}
</example>

</formatting>`;
