---
name: todo
description: "Manage tasks and to-do lists with add, complete, and list operations. Use when: user wants to add, complete, or view tasks and to-do items. Don't use when: user wants to save a note without task tracking (use notes skill) or set a timed reminder (use reminders skill)."
version: "1.0.0"
emoji: "✅"
---

# Todo

## Use when
- "add to my todo", "what's on my list", "mark X as done"
- Task management with done/not-done tracking
- Clear completed tasks

## Don't use when
- Save a quick note without tracking (use notes)
- Time-based reminder (use reminders)
- Schedule something (use reminders or cron tools)

## Instructions
Task management using workspace/todo.json file.

**Adding tasks:**
1. Read current todo.json (or create empty array if missing)
2. Add new task: { "id": timestamp, "task": "text", "done": false, "created": ISO date }
3. Write updated JSON back
4. Confirm: "Added: [task]"

**Listing tasks:**
1. Read todo.json
2. Format as:
   ☐ Task 1
   ☐ Task 2
   ☑ Completed task
3. Show count: "3 tasks (1 done)"

**Completing tasks:**
1. Find task by text match or number
2. Set "done": true, add "completed": ISO date
3. Confirm: "✅ Completed: [task]"

**Clearing completed:**
1. Filter out done tasks
2. Save cleaned list

Use read/write tools on "todo.json" for storage.
