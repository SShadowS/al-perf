table 50973 "Merge Ambig"
{
    fields
    {
        field(1; "No."; Code[20])
        {
        }
        field(2; AlphaOnly; Text[50])
        {
            TableRelation = Customer."No.";
        }
        field(3; "Ambig Lookup"; Text[100])
        {
            FieldClass = FlowField;
            CalcFormula = Lookup("Test Table".Description where("No." = field("No.")));
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
    }
}
