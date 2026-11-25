---
id: feedback-delete
kind: command
category: feedback
subcategory: feedback
title: feedback delete
symbol: supabase feedback delete
summary: Delete submitted feedback
usage: supabase feedback delete <token> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: token
    location: positional
    required: true
  - name: --project-ref
    location: flag
    type: string
    description: Project ref the feedback was submitted with.
examples:
  - id: example-1
    title: Delete feedback using the token printed when it was submitted
    lang: sh
    code: supabase feedback delete 123e4567-e89b-12d3-a456-426614174000
---

Remove feedback you sent earlier. Use the deletion token printed when you submitted it.
