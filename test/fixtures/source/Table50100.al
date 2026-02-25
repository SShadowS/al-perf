table 50100 "Test Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Description; Text[100]) { }
    }

    trigger OnInsert()
    begin
        Validate("No.");
    end;

    trigger OnModify()
    var
        Related: Record "Test Table";
    begin
        if Related.Get("No.") then
            Related.Modify();
    end;

    procedure LookupRecords()
    var
        Customer: Record Customer;
        i: Integer;
    begin
        for i := 1 to 100 do begin
            Customer.Get(i);
            Customer.CalcFields(Balance);
        end;
    end;
}
