import { Context, Effect, Stream } from "effect";
import * as Subscription from "foldkit/subscription";

import type { Key } from "../terminal/key.ts";

/** The run's decoded key stream, after the runtime has taken the keys that interrupt the run. */
export class Keys extends Context.Service<Keys, Stream.Stream<Key>>()("@supabase/tui/Keys") {}

/** Keys of the surrounding `Tui.run`; stdin is only acquired once a subscription reads this stream. */
export const keys: Stream.Stream<Key, never, Keys> = Stream.unwrap(Effect.service(Keys));

/** A subscription entry that maps every key of the run to a program message. */
export const keyEntry = <Message>(toMessage: (key: Key) => Message) =>
  Subscription.persistentEntry(Stream.map(keys, toMessage));
