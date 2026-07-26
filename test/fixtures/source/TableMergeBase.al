table 50970 "Merge Base"
{
    fields
    {
        field(1; "No."; Code[20])
        {
        }
        field(2; "Posting Date"; Date)
        {
        }
        field(3; Description; Text[100])
        {
        }
        field(4; "Base Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = Sum("Test Table".Amount where("No." = field("No.")));
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
        key(ByDate; "Posting Date")
        {
        }
    }
}
