table 50900 "Implicit Rec Test"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Decimal) { }
    }

    procedure RefreshAmount()
    begin
        // Bare call, no receiver -- the implicit Rec. Idiomatic in table/page/
        // report/XMLport code, and previously invisible: collectRecordOps only
        // matched `member_expression` calls (`SomeRec.CalcFields(...)`), never
        // a plain identifier call.
        CalcFields(Amount);
    end;
}
