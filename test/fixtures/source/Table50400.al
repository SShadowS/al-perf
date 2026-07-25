table 50400 "Key Test Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Customer No."; Code[20])
        {
            TableRelation = Customer."No.";
        }
        field(3; "Posting Date"; Date) { }
        field(4; Amount; Decimal) { }
        field(5; Description; Text[100]) { }
        field(6; "Date Filter"; Date)
        {
            FieldClass = FlowFilter;
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
        key(CustomerDate; "Customer No.", "Posting Date") { }
        key(AmountIdx; Amount) { }
    }

    procedure HasRelatedEntries(): Boolean
    begin
        exit(true);
    end;
}
