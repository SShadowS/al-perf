codeunit 50999 "Collision Handler"
{
    procedure Refresh()
    var
        Customer: Record Customer;
    begin
        if Customer.FindSet() then
            repeat
                Customer.CalcFields("Balance (LCY)");
            until Customer.Next() = 0;
    end;
}
