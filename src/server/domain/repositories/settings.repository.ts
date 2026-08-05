import type { TransactionHandle } from '../../application/ports/unit-of-work';

// What a setting may hold: JSON, because these are operational knobs that arrive one at a time and
// a column per knob is a migration per knob (docs/03 §3.3.21).
export type SettingValue =
  string | number | boolean | null | SettingValue[] | { [key: string]: SettingValue };

// Instance settings an admin changes at runtime. Values are opaque here: what a key means is the
// business of the service that reads it, and this only has to store it.
export abstract class SettingsRepository {
  abstract read(key: string, tx?: TransactionHandle): Promise<SettingValue>;

  abstract write(key: string, value: SettingValue, tx?: TransactionHandle): Promise<void>;
}
