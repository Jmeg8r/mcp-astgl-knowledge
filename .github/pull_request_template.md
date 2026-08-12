# Pull Request

## What changed

<!-- One or two sentences. The commit log has the detail. -->

## Why

<!-- The problem this solves. If it's from an issue, link it: Closes #NN -->

## Local gates

<!-- Tick what you ran. (An earlier revision claimed bin/ship.sh fills this in
     automatically — no such script ships here; the checklist is hand-ticked.) -->

- [ ] `lefthook run pre-commit` clean
- [ ] `lefthook run pre-push` clean
- [ ] `lefthook run review` run and findings addressed
      <!-- Runs `cr review --base "${CR_BASE:-main}"`. `main` is the default; on
           a stacked PR set CR_BASE (`CR_BASE=release-2.0 lefthook run review`)
           or the invocation reports drift that is not this PR's diff, and
           misses drift that is. -->
- [ ] `act` dry-run passed (if workflows changed)
- [ ] CodeRabbit has reviewed the CURRENT head — re-request after every push;
      a verdict on a stale commit is not a review of this PR

## Review focus

<!-- Point CodeRabbit and future-you at the risky part.
     Delete this section if the change is trivial. -->

## Content capture

<!-- ASTGL pipeline: was there a decision point, aha moment, or course
     correction worth writing up? Note it here while it's fresh. -->

**Tick exactly one.** If you tick the second, write the note on the same line —
an empty "Captured" is indistinguishable from an unticked box, which is the
thing this section exists to avoid.

- [ ] Nothing to capture
- [ ] Captured — note: _(what the decision, aha, or course-correction was)_
