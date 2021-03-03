---
feature: nikki-lyrics
start-date: 2020-01-28
author: kiwicopple
co-authors: kris10_burgess
related-issues: 
---

# Summary
[summary]: #summary

[@kris10_burgess](https://twitter.com/kris10_burgess) would [like to see Nikki Minaj lyrics](https://twitter.com/kris10_burgess/status/1354601237585518602) inside the CLI.

- Spec: https://github.com/supabase/cli/pull/4/files
- PR: https://github.com/supabase/cli/pull/4
  

# Motivation
[motivation]: #motivation

- Popular community demand.
- As a Supabase user, I don't want to use a browser to get the lyrics to "Super Bass" by Nikki Minaj.

# Detailed design
[design]: #detailed-design

When a user types `supa bass`, the CLI should return the lyrics the following lyrics


```
This one is for the boys with the booming system
Top down, AC with the cooling system
When he come up in the club, he be bl****' up
Got stacks on deck like he savin' up

And he ill, he real, he might got a deal
He pop bottles and he got the right kind of bill
He cold, he dope, he might sell co(cacola)
He always in the air, but he never fly coach

He a m****f*** trip, trip, sailor of the ship, ship     <--- ship, ship should be in bold
When he make it drip, drip kiss him on the lip, lip
That's the kind of dude I was lookin' for
And yes you'll get slapped if you're lookin' h**

I said, excuse me, you're a hell of a guy
I mean my, my, my, my you're like pelican fly
I mean, you're so shy and I'm loving your tie
You're like slicker than the guy with the thing on his eye, oh

Yes I did, yes I did
Somebody please tell him who the F I is
I am Nicki Minaj, I mack them dudes up
Back coupes up, and chuck the deuce up

Boy, you got my heartbeat runnin' away
Beating like a drum and it's coming your way
Can't you hear that
Boom, badoom, boom, boom, badoom, boom, bass?
You got that super bass
Boom, badoom, boom, boom, badoom, boom, bass
Yeah, that's the super bassBoom, badoom, boom, boom, badoom, boom, bass
He got that super bass
Boom, badoom, boom, boom, badoom, boom, bass
He got that super bass

See I need you in my life for me to stay
No, no, no, no, no, I know you'll stay
No, no, no, no, no, don't go away

Boy, you got my heartbeat runnin' away
Don't you hear that heartbeat comin' your way?

Oh, it be like
Boom, badoom, boom, boom, badoom, boom, bass
Can't you hear that
Boom, badoom, boom, boom, badoom, boom, bass?

Boy, you got my heartbeat runnin' away
Beating like a drum and it's coming your way
Can't you hear that
Boom, badoom, boom, boom, badoom, boom, bass?

You got that super bass
Boom, badoom, boom, boom, badoom, boom, bass
Yeah, that's the super bass
Boom, badoom, boom, boom, badoom, boom, bass
He got that super bass
Boom, badoom, boom, boom, badoom, boom, bass
He got that super bass

```

# Drawbacks
[drawbacks]: #drawbacks

- Some offensive lyrics which we tolerate but don't necessarily condone in our community.
- May cause confusion for some developers about the spelling of Supabase - possibly misspelling it to Superbass

# Alternatives
[alternatives]: #alternatives

All About That (data)Bass, by Meghan Trainor

# Unresolved questions
[unresolved]: #unresolved-questions

Will Nikki approve?

# Future work
[future]: #future-work

Add a GPT3 chat bot trained on Nikki Lyrics.