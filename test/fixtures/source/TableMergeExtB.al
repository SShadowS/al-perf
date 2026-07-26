tableextension 50978 "Merge Base Ext B" extends "Merge Base"
{
    // A SECOND extension on the same root. Without one, no fixture table has
    // more than one contributing extension, so the extensions pass could lose
    // its sort entirely and every test would still pass.
    fields
    {
        field(50100; "ExtB Code"; Code[20])
        {
        }
    }

    keys
    {
        key(ByExtBCode; "ExtB Code")
        {
        }
    }
}
