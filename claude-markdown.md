# Claude Markdown

## Background

I use the Claude Code command line interface a lot.  I have found working with Claude to be most effective when I can type my prompts in Markdown.  I would like to see the Claude responses formatted the same way.

## Idea

I would like a simple app that has three windows: a prompt window, a response window, and a window with the raw Claude output.

## Requirements

* I am running this on a Mac, but I think a simple Electron wrapper will probably work.  I would like to keep the language to TypeScript or something I know so I can make edits.

* Responses from Claude will display as formatted Markdown.  **Bold** text will show up as bold, ## Section Heading ## will show up as a section heading, etc.

* Likewise, as I type prompts they should display as formatted Markdown.

* The response window should be on the top, the prompt window on the bottom, and spanning both on the right will be the raw output from the Claude API as a status window.

* I think this will work best as a wrapper around Claude code, but I'm not sure.