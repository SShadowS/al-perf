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
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
    }
}
